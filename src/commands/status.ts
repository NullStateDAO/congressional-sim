import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';
import { parseArgs, stringArg } from '../lib/args.js';
import { createQueue, createRedis } from '../queue.js';

const args = parseArgs();
const config = loadConfig();
const experimentId = stringArg(args, 'experiment', config.EXPERIMENT_ID);
const pool = createPool(config);
const redis = createRedis(config);
const queue = createQueue(config, redis);
try {
  await migrate(pool);
  const statuses = (
    await pool.query<{ status: string; count: number }>(
      `select status, count(*)::int as count
       from simulation_jobs where experiment_id = $1
       group by status order by status`,
      [experimentId],
    )
  ).rows;
  const workers = (
    await pool.query<{
      worker_id: string;
      key_fingerprint: string;
      concurrency: number;
      current_jobs: number;
      heartbeat_at: Date;
    }>(
      `select worker_id, key_fingerprint, concurrency, current_jobs, heartbeat_at
       from worker_heartbeats
       where heartbeat_at >= now() - interval '60 seconds'
       order by worker_id`,
    )
  ).rows;
  const queueCounts = await queue.getJobCounts(
    'wait',
    'active',
    'delayed',
    'completed',
    'failed',
  );
  console.log(
    JSON.stringify({ experimentId, statuses, queue: queueCounts, workers }, null, 2),
  );
} finally {
  await queue.close();
  redis.disconnect();
  await pool.end();
}
