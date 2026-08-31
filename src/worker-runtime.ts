import os from 'node:os';
import { setInterval } from 'node:timers';

import type { S3Client } from '@aws-sdk/client-s3';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type pg from 'pg';

import type { AppConfig } from './config.js';
import { contentHash, sha256, stableJson } from './lib/hash.js';
import { ModelClient } from './openrouter.js';
import type { SimulationJob } from './queue.js';
import { loadReference } from './reference.js';
import { getSimulation } from './simulations/index.js';
import { putObject } from './storage.js';

type ExistingResult = {
  status: string;
  result: unknown;
  artifact_key: string | null;
};

export function keyFingerprint(config: AppConfig): string {
  if (config.SIMULATION_TRANSPORT === 'mock') return 'mock';
  return `sha256:${sha256(config.OPENROUTER_API_KEY ?? '').slice(0, 12)}`;
}

export function startSimulationWorker(input: {
  config: AppConfig;
  pool: pg.Pool;
  redis: Redis;
  s3: S3Client;
}): Worker<SimulationJob> {
  const { config, pool, redis, s3 } = input;
  const model = new ModelClient(config);
  let active = 0;
  const startedAt = new Date();
  const heartbeat = async () => {
    await pool.query(
      `insert into worker_heartbeats (
         worker_id, key_fingerprint, hostname, concurrency,
         started_at, heartbeat_at, current_jobs
       ) values ($1, $2, $3, $4, $5, now(), $6)
       on conflict (worker_id) do update set
         key_fingerprint = excluded.key_fingerprint,
         hostname = excluded.hostname,
         concurrency = excluded.concurrency,
         started_at = excluded.started_at,
         heartbeat_at = excluded.heartbeat_at,
         current_jobs = excluded.current_jobs`,
      [
        config.WORKER_ID,
        keyFingerprint(config),
        os.hostname(),
        config.WORKER_CONCURRENCY,
        startedAt,
        active,
      ],
    );
  };
  void heartbeat();
  const heartbeatTimer = setInterval(() => void heartbeat(), 15_000);
  heartbeatTimer.unref();

  const worker = new Worker<SimulationJob>(
    config.QUEUE_NAME,
    async (job) => {
      active += 1;
      try {
        return await executeJob(job, { config, pool, s3, model });
      } finally {
        active -= 1;
      }
    },
    {
      connection: redis,
      concurrency: config.WORKER_CONCURRENCY,
      lockDuration: Math.max(config.OPENROUTER_TIMEOUT_MS * 2, 300_000),
      maxStalledCount: 2,
    },
  );

  worker.on('completed', (job) => {
    console.log(
      JSON.stringify({ event: 'completed', worker: config.WORKER_ID, job: job.id }),
    );
  });
  worker.on('failed', (job, error) => {
    console.error(
      JSON.stringify({
        event: 'failed',
        worker: config.WORKER_ID,
        job: job?.id ?? null,
        attempt: job?.attemptsMade ?? null,
        error: error.message,
      }),
    );
    if (job && job.attemptsMade >= Number(job.opts.attempts ?? 1)) {
      void pool.query(
        `update simulation_jobs
         set status = 'failed', error_text = $2, finished_at = now()
         where job_id = $1 and status <> 'complete'`,
        [job.data.jobId, error.message.slice(0, 8_000)],
      );
    }
  });
  worker.on('error', (error) => {
    console.error(JSON.stringify({ event: 'worker-error', error: error.message }));
  });
  worker.on('closing', () => clearInterval(heartbeatTimer));
  return worker;
}

async function executeJob(
  job: Job<SimulationJob>,
  dependencies: {
    config: AppConfig;
    pool: pg.Pool;
    s3: S3Client;
    model: ModelClient;
  },
): Promise<unknown> {
  const { config, pool, s3, model } = dependencies;
  const [existing] = (
    await pool.query<ExistingResult>(
      'select status, result, artifact_key from simulation_jobs where job_id = $1',
      [job.data.jobId],
    )
  ).rows;
  if (existing?.status === 'complete') {
    return { resumed: true, result: existing.result, artifactKey: existing.artifact_key };
  }

  const attempt = job.attemptsMade + 1;
  await pool.query(
    `update simulation_jobs
     set status = 'running', worker_id = $2, attempts = greatest(attempts, $3),
       started_at = coalesce(started_at, now()), error_text = null
     where job_id = $1 and status <> 'complete'`,
    [job.data.jobId, config.WORKER_ID, attempt],
  );
  const startedAt = new Date();
  try {
    const files = await loadReference(
      s3,
      config,
      job.data.referenceKey,
      job.data.referenceHash,
    );
    const simulation = getSimulation(job.data.simulationType);
    const task = simulation.tasks(files).find(
      (candidate) => candidate.taskId === job.data.taskId,
    );
    if (!task) throw new Error(`Reference does not contain task ${job.data.taskId}`);
    const execution = await simulation.execute({
      files,
      task,
      seed: job.data.seed,
      model: job.data.model,
      modelClient: model,
    });
    const result = execution.result;
    const latencyMs = execution.calls.reduce(
      (sum, call) => sum + call.response.latencyMs,
      0,
    );
    const promptTokens = execution.calls.reduce(
      (sum, call) => sum + Number(call.response.promptTokens ?? 0),
      0,
    );
    const completionTokens = execution.calls.reduce(
      (sum, call) => sum + Number(call.response.completionTokens ?? 0),
      0,
    );
    const finishedAt = new Date();
    const artifact = {
      schemaVersion: 1,
      experimentId: job.data.experimentId,
      jobId: job.data.jobId,
      taskId: job.data.taskId,
      seed: job.data.seed,
      attempt,
      worker: {
        id: config.WORKER_ID,
        keyFingerprint: keyFingerprint(config),
      },
      reference: {
        manifestKey: job.data.referenceKey,
        manifestHash: job.data.referenceHash,
      },
      calls: execution.calls,
      result,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };
    const artifactText = `${stableJson(artifact)}\n`;
    const artifactKey = `experiments/${job.data.experimentId}/jobs/${job.data.jobId}/attempts/${attempt}.json`;
    const stored = await putObject(s3, config, artifactKey, artifactText);
    await pool.query(
      `update simulation_jobs
       set status = 'complete', result = $2::jsonb, artifact_key = $3,
         artifact_hash = $4, error_text = null, latency_ms = $5,
         prompt_tokens = $6, completion_tokens = $7, finished_at = now()
       where job_id = $1 and status <> 'complete'`,
      [
        job.data.jobId,
        JSON.stringify(result),
        stored.key,
        stored.hash,
        latencyMs,
        promptTokens,
        completionTokens,
      ],
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorArtifact = `${stableJson({
      schemaVersion: 1,
      experimentId: job.data.experimentId,
      jobId: job.data.jobId,
      attempt,
      workerId: config.WORKER_ID,
      error: message.slice(0, 8_000),
      failedAt: new Date().toISOString(),
    })}\n`;
    await putObject(
      s3,
      config,
      `experiments/${job.data.experimentId}/jobs/${job.data.jobId}/attempts/${attempt}-error.json`,
      errorArtifact,
    ).catch(() => undefined);
    await pool.query(
      `update simulation_jobs
       set status = 'retrying', error_text = $2
       where job_id = $1 and status <> 'complete'`,
      [job.data.jobId, message.slice(0, 8_000)],
    );
    throw error instanceof Error ? error : new Error(message);
  }
}
