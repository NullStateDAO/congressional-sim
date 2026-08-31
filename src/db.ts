import pg from 'pg';

import type { AppConfig } from './config.js';

const { Pool } = pg;

export function createPool(config: AppConfig): pg.Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`
    create table if not exists experiments (
      experiment_id text primary key,
      simulation_type text not null,
      model text not null,
      reference_key text not null,
      reference_hash text not null,
      expected_jobs integer not null check (expected_jobs >= 0),
      status text not null check (status in ('preparing', 'running', 'complete', 'failed')),
      configuration jsonb not null,
      created_at timestamptz not null default now(),
      completed_at timestamptz
    );

    create table if not exists simulation_jobs (
      job_id text primary key,
      experiment_id text not null references experiments(experiment_id) on delete cascade,
      task_id text not null,
      seed integer not null,
      status text not null check (status in ('pending', 'running', 'retrying', 'complete', 'failed')),
      worker_id text,
      attempts integer not null default 0,
      artifact_key text,
      artifact_hash text,
      result jsonb,
      error_text text,
      latency_ms integer,
      prompt_tokens integer,
      completion_tokens integer,
      created_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz,
      unique (experiment_id, task_id, seed)
    );

    create index if not exists simulation_jobs_experiment_status_idx
      on simulation_jobs (experiment_id, status, created_at);

    create table if not exists worker_heartbeats (
      worker_id text primary key,
      key_fingerprint text not null,
      hostname text not null,
      concurrency integer not null,
      started_at timestamptz not null,
      heartbeat_at timestamptz not null,
      current_jobs integer not null default 0
    );
  `);
}
