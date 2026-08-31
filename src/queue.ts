import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { AppConfig } from './config.js';

export type SimulationJob = {
  experimentId: string;
  jobId: string;
  taskId: string;
  seed: number;
  simulationType: string;
  referenceKey: string;
  referenceHash: string;
  model: string;
};

export function createRedis(config: AppConfig): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function createQueue(
  config: AppConfig,
  connection = createRedis(config),
): Queue<SimulationJob> {
  return new Queue<SimulationJob>(config.QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000, jitter: 0.35 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100_000 },
      removeOnFail: false,
    },
  });
}
