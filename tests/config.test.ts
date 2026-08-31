import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://sim:password@localhost:5432/sim',
  REDIS_URL: 'redis://:password@localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'artifacts',
  S3_ACCESS_KEY_ID: 'access',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('configuration', () => {
  it('permits mock workers without an OpenRouter key', () => {
    expect(loadConfig({ ...base, SIMULATION_TRANSPORT: 'mock' })).toMatchObject({
      SIMULATION_TRANSPORT: 'mock',
      WORKER_CONCURRENCY: 4,
    });
  });

  it('requires a key for OpenRouter workers', () => {
    expect(() =>
      loadConfig({ ...base, SIMULATION_TRANSPORT: 'openrouter' }),
    ).toThrow(/OPENROUTER_API_KEY/);
  });
});
