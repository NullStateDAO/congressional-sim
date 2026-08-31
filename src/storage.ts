import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { AppConfig } from './config.js';
import { contentHash } from './lib/hash.js';

export type StoredObject = {
  key: string;
  hash: string;
  size: number;
};

export function createS3(config: AppConfig): S3Client {
  return new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
  });
}

export async function ensureBucket(
  client: S3Client,
  config: AppConfig,
): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  }
}

export async function putObject(
  client: S3Client,
  config: AppConfig,
  key: string,
  content: string | Uint8Array,
  contentType = 'application/json',
): Promise<StoredObject> {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  const hash = contentHash(bytes);
  await client.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      Metadata: { contentHash: hash },
    }),
  );
  return { key, hash, size: bytes.byteLength };
}

export async function getObject(
  client: S3Client,
  config: AppConfig,
  key: string,
  expectedHash?: string,
): Promise<Uint8Array> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
  );
  if (!response.Body) throw new Error(`S3 object has no body: ${key}`);
  const bytes = await response.Body.transformToByteArray();
  const actual = contentHash(bytes);
  if (expectedHash && actual !== expectedHash) {
    throw new Error(
      `Reference integrity failure for ${key}: expected ${expectedHash}, got ${actual}`,
    );
  }
  return bytes;
}
