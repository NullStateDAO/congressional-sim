import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

import { loadConfig } from '../config.js';
import { parseArgs, stringArg } from '../lib/args.js';
import { createS3 } from '../storage.js';

const args = parseArgs();
const config = loadConfig();
const experimentId = stringArg(args, 'experiment', config.EXPERIMENT_ID);
const outputRoot = path.resolve(stringArg(args, 'output'));
const prefix = `experiments/${experimentId}/`;
const s3 = createS3(config);
let continuationToken: string | undefined;
let downloaded = 0;
do {
  const page = await s3.send(
    new ListObjectsV2Command({
      Bucket: config.S3_BUCKET,
      Prefix: prefix,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }),
  );
  for (const object of page.Contents ?? []) {
    if (!object.Key?.startsWith(prefix)) continue;
    const relative = object.Key.slice(prefix.length);
    if (!relative || relative.split('/').some((part) => part === '..')) continue;
    const response = await s3.send(
      new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: object.Key }),
    );
    if (!response.Body) throw new Error(`Object has no body: ${object.Key}`);
    const destination = path.join(outputRoot, experimentId, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await response.Body.transformToByteArray());
    downloaded += 1;
  }
  continuationToken = page.NextContinuationToken;
} while (continuationToken);
console.log(JSON.stringify({ experimentId, outputRoot, downloaded }, null, 2));
