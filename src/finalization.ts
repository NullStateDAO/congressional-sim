import type { S3Client } from '@aws-sdk/client-s3';
import type pg from 'pg';

import type { AppConfig } from './config.js';
import { stableJson } from './lib/hash.js';
import { putObject, type StoredObject } from './storage.js';

export async function finalizeExperiment(
  pool: pg.Pool,
  s3: S3Client,
  config: AppConfig,
  experimentId: string,
  options: { allowIncomplete?: boolean } = {},
): Promise<{ manifest: unknown; stored: StoredObject; choices: Record<string, number> }> {
  const experiment = (
    await pool.query('select * from experiments where experiment_id = $1', [
      experimentId,
    ])
  ).rows[0];
  if (!experiment) throw new Error(`Unknown experiment ${experimentId}`);
  const jobs = (
    await pool.query(
      `select job_id, task_id, seed, status, worker_id, attempts, artifact_key,
         artifact_hash, result, error_text, latency_ms, prompt_tokens,
         completion_tokens, started_at, finished_at
       from simulation_jobs where experiment_id = $1
       order by task_id, seed`,
      [experimentId],
    )
  ).rows;
  if (jobs.length !== Number(experiment.expected_jobs)) {
    throw new Error(
      `Experiment ${experimentId} has ${jobs.length}/${experiment.expected_jobs} expected job rows`,
    );
  }
  const incomplete = jobs.filter((job) => job.status !== 'complete');
  if (incomplete.length && !options.allowIncomplete) {
    throw new Error(
      `Experiment ${experimentId} is not complete: ${incomplete.length}/${jobs.length} jobs remain`,
    );
  }
  const choices = jobs.reduce<Record<string, number>>((counts, job) => {
    const result = job.result as { choice?: unknown; vote?: unknown } | null;
    const choice = String(result?.vote ?? result?.choice ?? 'unknown');
    counts[choice] = (counts[choice] ?? 0) + 1;
    return counts;
  }, {});
  const manifest = {
    schemaVersion: 1,
    experiment,
    summary: {
      jobs: jobs.length,
      incompleteJobs: incomplete.length,
      choices,
      totalPromptTokens: jobs.reduce(
        (sum, job) => sum + Number(job.prompt_tokens ?? 0),
        0,
      ),
      totalCompletionTokens: jobs.reduce(
        (sum, job) => sum + Number(job.completion_tokens ?? 0),
        0,
      ),
    },
    jobs,
    finalizedAt: new Date().toISOString(),
  };
  const stored = await putObject(
    s3,
    config,
    `experiments/${experimentId}/manifest.json`,
    `${stableJson(manifest)}\n`,
  );
  await pool.query(
    `update experiments set status = 'complete', completed_at = now()
     where experiment_id = $1`,
    [experimentId],
  );
  return { manifest, stored, choices };
}
