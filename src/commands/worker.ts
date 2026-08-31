import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';
import { createRedis } from '../queue.js';
import { createS3, ensureBucket } from '../storage.js';
import { startSimulationWorker } from '../worker-runtime.js';

const config = loadConfig();
const pool = createPool(config);
await migrate(pool);
const redis = createRedis(config);
const s3 = createS3(config);
await ensureBucket(s3, config);
const worker = startSimulationWorker({ config, pool, redis, s3 });

console.log(
  JSON.stringify({
    event: 'worker-ready',
    worker: config.WORKER_ID,
    concurrency: config.WORKER_CONCURRENCY,
    providerConcurrency: config.OPENROUTER_CONCURRENCY,
    transport: config.SIMULATION_TRANSPORT,
  }),
);

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ event: 'worker-stopping', signal }));
  await worker.close();
  redis.disconnect();
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
