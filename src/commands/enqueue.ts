import path from 'node:path';

import type pg from 'pg';

import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';
import { deterministicId, stableJson } from '../lib/hash.js';
import { numberArg, parseArgs, stringArg } from '../lib/args.js';
import { createQueue, createRedis, type SimulationJob } from '../queue.js';
import { loadReference, publishReference } from '../reference.js';
import { getSimulation } from '../simulations/index.js';
import { createS3, ensureBucket } from '../storage.js';

const args = parseArgs();
const config = loadConfig();
const experimentId = stringArg(args, 'experiment', config.EXPERIMENT_ID);
const seeds = numberArg(args, 'seeds', 1);
const model = stringArg(args, 'model', config.OPENROUTER_MODEL);
const simulationType = stringArg(args, 'simulation', 'hello-world');
const issueFilter = typeof args.issue === 'string' ? args.issue : null;
const referenceName = stringArg(args, 'reference-name', config.REFERENCE_NAME);
const referenceVersion = stringArg(
  args,
  'reference-version',
  config.REFERENCE_VERSION,
);
const writeBatchSize = numberArg(args, 'write-batch-size', 1000);

const pool = createPool(config);
const redis = createRedis(config);
const queue = createQueue(config, redis);
const s3 = createS3(config);

try {
  await migrate(pool);
  await ensureBucket(s3, config);
  const reference = await publishReference(
    s3,
    config,
    path.resolve(stringArg(args, 'reference-dir', config.REFERENCE_DIR)),
    referenceName,
    referenceVersion,
  );
  const files = await loadReference(
    s3,
    config,
    reference.key,
    reference.hash,
  );
  const simulation = getSimulation(simulationType);
  const allTasks = simulation.tasks(files);
  const selectedTasks = issueFilter
    ? allTasks.filter((task) => task.issueId === issueFilter)
    : allTasks;
  if (issueFilter && selectedTasks.length === 0) {
    throw new Error(`No tasks found for issue ${issueFilter}`);
  }
  const allJobs: SimulationJob[] = allTasks.flatMap((task) =>
    Array.from({ length: seeds }, (_, seed) => ({
      experimentId,
      jobId: deterministicId({
        experimentId,
        simulationType,
        referenceHash: reference.hash,
        model,
        taskId: task.taskId,
        seed,
      }),
      taskId: task.taskId,
      seed,
      simulationType,
      referenceKey: reference.key,
      referenceHash: reference.hash,
      model,
    })),
  );
  const selectedTaskIds = new Set(selectedTasks.map((task) => task.taskId));
  const selectedJobs = allJobs.filter((job) => selectedTaskIds.has(job.taskId));
  const configuration = {
    simulationType,
    model,
    seeds,
    referenceName,
    referenceVersion,
    referenceKey: reference.key,
    referenceHash: reference.hash,
    expectedTasks: allTasks.length,
  };
  await pool.query(
    `insert into experiments (
       experiment_id, simulation_type, model, reference_key, reference_hash,
       expected_jobs, status, configuration
     ) values ($1, $2, $3, $4, $5, $6, 'preparing', $7::jsonb)
     on conflict (experiment_id) do nothing`,
    [
      experimentId,
      simulationType,
      model,
      reference.key,
      reference.hash,
      allJobs.length,
      stableJson(configuration),
    ],
  );
  const existing = (
    await pool.query<{
      model: string;
      reference_hash: string;
      expected_jobs: number;
      configuration: unknown;
    }>(
      `select model, reference_hash, expected_jobs, configuration
       from experiments where experiment_id = $1`,
      [experimentId],
    )
  ).rows[0];
  if (
    !existing ||
    existing.model !== model ||
    existing.reference_hash !== reference.hash ||
    existing.expected_jobs !== allJobs.length ||
    stableJson(existing.configuration) !== stableJson(configuration)
  ) {
    throw new Error(
      `Experiment ${experimentId} already exists with different immutable inputs`,
    );
  }

  await insertJobs(pool, selectedJobs, writeBatchSize);
  for (const batch of chunks(selectedJobs, writeBatchSize)) {
    await queue.addBulk(
      batch.map((job) => ({
        name: job.simulationType,
        data: job,
        opts: { jobId: job.jobId },
      })),
    );
  }
  await pool.query(
    `update experiments set status = 'running'
     where experiment_id = $1 and status <> 'complete'`,
    [experimentId],
  );
  console.log(
    JSON.stringify(
      {
        experimentId,
        queuedJobs: selectedJobs.length,
        expectedJobs: allJobs.length,
        queuedTasks: selectedTasks.length,
        expectedTasks: allTasks.length,
        issue: issueFilter,
        seeds,
        referenceKey: reference.key,
        referenceHash: reference.hash,
      },
      null,
      2,
    ),
  );
} finally {
  await queue.close();
  redis.disconnect();
  await pool.end();
}

async function insertJobs(
  pool: pg.Pool,
  jobs: SimulationJob[],
  batchSize: number,
): Promise<void> {
  for (const batch of chunks(jobs, batchSize)) {
    await pool.query(
      `insert into simulation_jobs (
         job_id, experiment_id, task_id, seed, status
       )
       select job_id, experiment_id, task_id, seed, 'pending'
       from unnest($1::text[], $2::text[], $3::text[], $4::int[])
         as input(job_id, experiment_id, task_id, seed)
       on conflict (job_id) do nothing`,
      [
        batch.map((job) => job.jobId),
        batch.map((job) => job.experimentId),
        batch.map((job) => job.taskId),
        batch.map((job) => job.seed),
      ],
    );
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
