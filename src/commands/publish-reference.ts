import path from 'node:path';

import { loadConfig } from '../config.js';
import { parseArgs, stringArg } from '../lib/args.js';
import { publishReference } from '../reference.js';
import { createS3, ensureBucket } from '../storage.js';

const args = parseArgs();
const config = loadConfig();
const s3 = createS3(config);
await ensureBucket(s3, config);
const published = await publishReference(
  s3,
  config,
  path.resolve(stringArg(args, 'dir', config.REFERENCE_DIR)),
  stringArg(args, 'name', config.REFERENCE_NAME),
  stringArg(args, 'version', config.REFERENCE_VERSION),
);
console.log(JSON.stringify(published, null, 2));
