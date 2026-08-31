import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';
import { finalizeExperiment } from '../finalization.js';
import { parseArgs, stringArg } from '../lib/args.js';
import { stableJson } from '../lib/hash.js';
import { createS3, ensureBucket } from '../storage.js';

const args = parseArgs();
const config = loadConfig();
const experimentId = stringArg(args, 'experiment', config.EXPERIMENT_ID);
const pool = createPool(config);
const s3 = createS3(config);
try {
  await migrate(pool);
  await ensureBucket(s3, config);
  const { manifest, stored, choices } = await finalizeExperiment(
    pool,
    s3,
    config,
    experimentId,
    { allowIncomplete: args['allow-incomplete'] === true },
  );
  const text = `${stableJson(manifest)}\n`;
  if (args.output) {
    const output = path.resolve(String(args.output));
    await writeFile(output, text);
  }
  console.log(JSON.stringify({ experimentId, ...stored, choices }, null, 2));
} finally {
  await pool.end();
}
