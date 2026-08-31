import { setTimeout as delay } from 'node:timers/promises';

import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';
import { finalizeExperiment } from '../finalization.js';
import { numberArg, parseArgs, stringArg } from '../lib/args.js';
import { createS3, ensureBucket } from '../storage.js';

const args = parseArgs();
const config = loadConfig();
const experimentId = stringArg(args, 'experiment', config.EXPERIMENT_ID);
const intervalSeconds = numberArg(args, 'interval', 15);
const pool = createPool(config);
const s3 = createS3(config);
try {
  await migrate(pool);
  await ensureBucket(s3, config);
  while (true) {
    const counts = (
      await pool.query<{ status: string; count: number }>(
        `select status, count(*)::int as count
         from simulation_jobs where experiment_id = $1
         group by status order by status`,
        [experimentId],
      )
    ).rows;
    console.log(
      JSON.stringify({
        event: 'experiment-progress',
        experimentId,
        counts,
        checkedAt: new Date().toISOString(),
      }),
    );
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    const complete = counts.find((row) => row.status === 'complete')?.count ?? 0;
    const failed = counts.find((row) => row.status === 'failed')?.count ?? 0;
    const experiment = (
      await pool.query<{ expected_jobs: number }>(
        'select expected_jobs from experiments where experiment_id = $1',
        [experimentId],
      )
    ).rows[0];
    const expected = experiment?.expected_jobs ?? 0;
    if (failed > 0) {
      await pool.query(
        `update experiments set status = 'failed'
         where experiment_id = $1 and status <> 'complete'`,
        [experimentId],
      );
      console.error(
        JSON.stringify({
          event: 'experiment-has-failures',
          experimentId,
          failed,
          checkedAt: new Date().toISOString(),
        }),
      );
      await delay(intervalSeconds * 1_000);
      continue;
    }
    await pool.query(
      `update experiments set status = 'running'
       where experiment_id = $1 and status = 'failed'`,
      [experimentId],
    );
    if (expected > 0 && total === expected && complete === expected) {
      const finalized = await finalizeExperiment(
        pool,
        s3,
        config,
        experimentId,
      );
      console.log(
        JSON.stringify({
          event: 'experiment-complete',
          experimentId,
          manifestKey: finalized.stored.key,
          choices: finalized.choices,
        }),
      );
      break;
    }
    await delay(intervalSeconds * 1_000);
  }
} finally {
  await pool.end();
}
