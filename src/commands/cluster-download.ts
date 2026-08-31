import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readState, safeClusterName } from '../cluster.js';
import { parseArgs, stringArg } from '../lib/args.js';
import { run } from '../lib/process.js';

const root = path.resolve(import.meta.dirname, '../..');
const args = parseArgs();
const cluster = safeClusterName(stringArg(args, 'cluster'));
const state = await readState(root, cluster);
const output = path.resolve(stringArg(args, 'output', path.join(root, 'out')));
const privateKey = path.resolve(
  String(
    args['ssh-private-key'] ??
      process.env.SSH_PRIVATE_KEY ??
      path.join(os.homedir(), '.ssh/id_ed25519'),
  ),
);
const sshOptions = [
  '-i',
  privateKey,
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
];
const remoteArchive = `/opt/openrouter-sim/${state.experimentId}-artifacts.tar.gz`;
await run(
  'ssh',
  [
    ...sshOptions,
    `root@${state.controller.publicIp}`,
    [
      `rm -rf /opt/openrouter-sim/export/${state.experimentId}`,
      'mkdir -p /opt/openrouter-sim/export',
      `docker run --rm --user 0:0 --network host --env-file /opt/openrouter-sim/app.env -v /opt/openrouter-sim/export:/export ${state.image} dist/commands/download.js --experiment ${state.experimentId} --output /export`,
      `tar -czf ${remoteArchive} -C /opt/openrouter-sim/export ${state.experimentId}`,
    ].join(' && '),
  ],
  { quiet: true },
);
await mkdir(output, { recursive: true });
const localArchive = path.join(output, `${state.experimentId}-artifacts.tar.gz`);
await run(
  'scp',
  [
    ...sshOptions,
    `root@${state.controller.publicIp}:${remoteArchive}`,
    localArchive,
  ],
  { quiet: true },
);
console.log(JSON.stringify({ cluster, experimentId: state.experimentId, localArchive }, null, 2));
