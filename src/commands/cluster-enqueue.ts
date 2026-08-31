import os from 'node:os';
import path from 'node:path';

import { readState, safeClusterName } from '../cluster.js';
import { numberArg, parseArgs, stringArg } from '../lib/args.js';
import { run } from '../lib/process.js';

const root = path.resolve(import.meta.dirname, '../..');
const args = parseArgs();
const cluster = safeClusterName(stringArg(args, 'cluster'));
const state = await readState(root, cluster);
const experimentId = stringArg(args, 'experiment', state.experimentId);
const simulationType = stringArg(args, 'simulation', 'congressional-direct-vote');
const referenceName = stringArg(args, 'reference-name', simulationType);
const referenceVersion = stringArg(args, 'reference-version', 'v1');
const referenceDir = stringArg(
  args,
  'reference-dir',
  `/app/reference/${referenceName}/${referenceVersion}`,
);
const seeds = numberArg(args, 'seeds', 1);
const model = stringArg(args, 'model', 'deepseek/deepseek-v4-flash');
const issueFilter = typeof args.issue === 'string' ? args.issue : null;
const sshPrivateKey = path.resolve(
  String(
    args['ssh-private-key'] ??
      process.env.SSH_PRIVATE_KEY ??
      path.join(os.homedir(), '.ssh/id_ed25519'),
  ),
);

const command = [
  'docker run --rm --network host --env-file /opt/openrouter-sim/app.env',
  state.image,
  'dist/commands/enqueue.js',
  '--experiment',
  shellQuote(experimentId),
  '--simulation',
  shellQuote(simulationType),
  '--reference-name',
  shellQuote(referenceName),
  '--reference-version',
  shellQuote(referenceVersion),
  '--reference-dir',
  shellQuote(referenceDir),
  '--seeds',
  String(seeds),
  '--model',
  shellQuote(model),
  issueFilter ? `--issue ${shellQuote(issueFilter)}` : '',
]
  .filter(Boolean)
  .join(' ');

const output = await run(
  'ssh',
  [...sshArgs(sshPrivateKey), `root@${state.controller.publicIp}`, command],
  { quiet: true },
);
console.log(output.trim());

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sshArgs(privateKey: string): string[] {
  return [
    '-i',
    privateKey,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
  ];
}
