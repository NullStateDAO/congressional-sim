import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

import type { AppConfig } from './config.js';
import { contentHash, stableJson } from './lib/hash.js';
import { getObject, putObject } from './storage.js';

const ReferenceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  version: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      key: z.string().min(1),
      hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      size: z.number().int().nonnegative(),
      mediaType: z.string().min(1),
    }),
  ),
});

export type ReferenceManifest = z.infer<typeof ReferenceManifestSchema>;

export type PublishedReference = {
  key: string;
  hash: string;
  manifest: ReferenceManifest;
};

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) return listFiles(root, absolute);
      return [path.relative(root, absolute)];
    }),
  );
  return nested.flat().sort();
}

function mediaType(file: string): string {
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.jsonl')) return 'application/x-ndjson';
  if (file.endsWith('.csv')) return 'text/csv';
  if (file.endsWith('.md')) return 'text/markdown';
  return 'application/octet-stream';
}

export async function publishReference(
  client: S3Client,
  config: AppConfig,
  root: string,
  name: string,
  version: string,
): Promise<PublishedReference> {
  const prefix = `reference/${name}/${version}`;
  const files = [];
  for (const relative of await listFiles(root)) {
    if (relative === 'manifest.json') continue;
    const bytes = await readFile(path.join(root, relative));
    const stored = await putObject(
      client,
      config,
      `${prefix}/files/${contentHash(bytes).slice('sha256:'.length)}/${relative}`,
      bytes,
      mediaType(relative),
    );
    files.push({
      path: relative,
      key: stored.key,
      hash: stored.hash,
      size: stored.size,
      mediaType: mediaType(relative),
    });
  }
  const manifest: ReferenceManifest = {
    schemaVersion: 1,
    name,
    version,
    files,
  };
  const text = `${stableJson(manifest)}\n`;
  const hash = contentHash(text);
  const key = `${prefix}/manifests/${hash.slice('sha256:'.length)}.json`;
  const stored = await putObject(client, config, key, text);
  return { key, hash: stored.hash, manifest };
}

const referenceCache = new Map<string, Promise<Record<string, Uint8Array>>>();

export async function loadReference(
  client: S3Client,
  config: AppConfig,
  manifestKey: string,
  manifestHash: string,
): Promise<Record<string, Uint8Array>> {
  const cacheKey = `${manifestKey}:${manifestHash}`;
  let cached = referenceCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      const manifestBytes = await getObject(
        client,
        config,
        manifestKey,
        manifestHash,
      );
      const manifest = ReferenceManifestSchema.parse(
        JSON.parse(Buffer.from(manifestBytes).toString('utf8')),
      );
      const files: Record<string, Uint8Array> = {};
      await Promise.all(
        manifest.files.map(async (file) => {
          files[file.path] = await getObject(
            client,
            config,
            file.key,
            file.hash,
          );
        }),
      );
      return files;
    })().catch((error) => {
      referenceCache.delete(cacheKey);
      throw error;
    });
    referenceCache.set(cacheKey, cached);
  }
  return cached;
}

export function parseReferenceJson<T>(
  files: Record<string, Uint8Array>,
  name: string,
): T {
  const bytes = files[name];
  if (!bytes) throw new Error(`Reference bundle is missing ${name}`);
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
}

export function referenceHashForManifest(manifest: ReferenceManifest): string {
  return contentHash(`${stableJson(manifest)}\n`);
}
