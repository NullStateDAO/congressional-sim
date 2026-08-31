import 'dotenv/config';

import os from 'node:os';

import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const ConfigSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .default('postgres://sim:sim-local-only@127.0.0.1:45432/sim_cluster'),
  REDIS_URL: z
    .string()
    .url()
    .default('redis://:redis-local-only@127.0.0.1:46379'),
  QUEUE_NAME: z.string().min(1).default('simulation-jobs'),
  S3_ENDPOINT: z.string().url().default('http://127.0.0.1:49000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('simulation-artifacts'),
  S3_ACCESS_KEY_ID: z.string().min(1).default('sim-minio'),
  S3_SECRET_ACCESS_KEY: z.string().min(1).default('sim-minio-local-only'),
  S3_FORCE_PATH_STYLE: booleanString.default(true),
  SIMULATION_TRANSPORT: z.enum(['mock', 'openrouter']).default('mock'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().min(1).default('deepseek/deepseek-v4-flash'),
  OPENROUTER_PROVIDER: z.string().optional(),
  OPENROUTER_CONCURRENCY: z.coerce.number().int().min(1).max(512).default(32),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(128).default(4),
  WORKER_ID: z.string().optional(),
  EXPERIMENT_ID: z.string().min(1).default('hello-world-dev'),
  REFERENCE_DIR: z.string().min(1).default('reference/hello-world/v1'),
  REFERENCE_NAME: z.string().min(1).default('hello-world'),
  REFERENCE_VERSION: z.string().min(1).default('v1'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const config = ConfigSchema.parse(source);
  if (
    config.SIMULATION_TRANSPORT === 'openrouter' &&
    !config.OPENROUTER_API_KEY
  ) {
    throw new Error(
      'OPENROUTER_API_KEY is required when SIMULATION_TRANSPORT=openrouter',
    );
  }
  return {
    ...config,
    WORKER_ID: config.WORKER_ID ?? `${os.hostname()}-${process.pid}`,
  };
}
