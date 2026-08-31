import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const HostSchema = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string(),
  publicIp: z.ipv4(),
});

export const ClusterStateSchema = z.object({
  schemaVersion: z.literal(1),
  cluster: z.string(),
  experimentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/),
  region: z.string(),
  image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,200}$/),
  createdAt: z.string().datetime(),
  controller: HostSchema.extend({ privateIp: z.ipv4() }),
  workers: z.array(HostSchema),
});

export type ClusterState = z.infer<typeof ClusterStateSchema>;

export function statePath(root: string, cluster: string): string {
  return path.join(root, '.cluster', `${cluster}.json`);
}

export async function readState(
  root: string,
  cluster: string,
): Promise<ClusterState> {
  return ClusterStateSchema.parse(
    JSON.parse(await readFile(statePath(root, cluster), 'utf8')),
  );
}

export function safeClusterName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!normalized) throw new Error('Cluster name is empty after normalization');
  return normalized;
}

export function safeExperimentId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value)) {
    throw new Error(
      'Experiment ID must use 1-81 letters, numbers, dots, underscores, or dashes',
    );
  }
  return value;
}
