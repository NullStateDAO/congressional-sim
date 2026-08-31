import os from 'node:os';
import path from 'node:path';

import { readState, safeClusterName } from '../cluster.js';
import { parseArgs, stringArg } from '../lib/args.js';
import { run } from '../lib/process.js';

const root = path.resolve(import.meta.dirname, '../..');
const args = parseArgs();
const cluster = safeClusterName(stringArg(args, 'cluster'));
const state = await readState(root, cluster);
const privateKey = path.resolve(
  String(
    args['ssh-private-key'] ??
      process.env.SSH_PRIVATE_KEY ??
      path.join(os.homedir(), '.ssh/id_ed25519'),
  ),
);
const sshArgs = [
  '-i',
  privateKey,
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  `root@${state.controller.publicIp}`,
];
const status = await run(
  'ssh',
  [
    ...sshArgs,
    `docker run --rm --network host --env-file /opt/openrouter-sim/app.env ${state.image} dist/commands/status.js --experiment ${state.experimentId}`,
  ],
  { quiet: true },
);
const supervisor = await run(
  'ssh',
  [...sshArgs, 'docker logs --tail 12 simulation-supervisor 2>&1 || true'],
  { quiet: true },
);
console.log(status.trim());
console.log('\nSupervisor:');
console.log(supervisor.trim());
