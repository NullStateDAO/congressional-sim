import { rename } from 'node:fs/promises';
import path from 'node:path';

import { readState, safeClusterName, statePath } from '../cluster.js';
import { parseArgs, stringArg } from '../lib/args.js';
import { resolveGateway } from '../lib/gateway.js';
import { run } from '../lib/process.js';

const root = path.resolve(import.meta.dirname, '../..');
const args = parseArgs();
const cluster = safeClusterName(stringArg(args, 'cluster'));
const state = await readState(root, cluster);
const ids = [state.controller.id, ...state.workers.map((worker) => worker.id)];
if (args.apply !== true) {
  console.log(
    JSON.stringify(
      {
        mode: 'dry-run',
        cluster,
        dropletIds: ids,
        warning: 'Controller volumes and any artifacts left only in MinIO will be deleted.',
        apply: `pnpm cluster:destroy -- --cluster ${cluster} --apply`,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const gateway = resolveGateway(args.gateway);
const output = await run(
  gateway,
  [
    'run',
    '--repo',
    root,
    '--payload',
    JSON.stringify({
      action: 'digitalocean.droplets_delete',
      ids,
      costCapUsd: 0,
    }),
  ],
  { quiet: true },
);
const result = JSON.parse(output) as { status?: unknown };
if (result.status !== 'ok') throw new Error(`Droplet deletion failed: ${output}`);
const archived = path.join(
  root,
  '.cluster',
  `${cluster}.destroyed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
);
await rename(statePath(root, cluster), archived);
console.log(JSON.stringify({ status: 'destroyed', cluster, ids, archived }, null, 2));
