import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import {
  ClusterStateSchema,
  safeClusterName,
  safeExperimentId,
  statePath,
  type ClusterState,
} from '../cluster.js';
import { numberArg, parseArgs, stringArg } from '../lib/args.js';
import { resolveGateway } from '../lib/gateway.js';
import { createKeyAssignmentPlan } from '../lib/key-assignment.js';
import { run } from '../lib/process.js';

const root = path.resolve(import.meta.dirname, '../..');
const args = parseArgs();
const droplets = numberArg(args, 'droplets', 1);
const seeds = numberArg(args, 'seeds', 1);
const workerConcurrency = numberArg(args, 'worker-concurrency', 32);
const providerConcurrency = numberArg(args, 'provider-concurrency', 64);
const simulationType = stringArg(args, 'simulation', 'hello-world');
const referenceName = stringArg(args, 'reference-name', simulationType);
const referenceVersion = stringArg(args, 'reference-version', 'v1');
const referenceDir = stringArg(
  args,
  'reference-dir',
  `reference/${referenceName}/${referenceVersion}`,
);
const remoteReferenceDir = toRemoteAppPath(referenceDir, 'reference-dir');
const issueFilter = typeof args.issue === 'string' ? args.issue : null;
const cluster = safeClusterName(
  stringArg(args, 'cluster', `sim-${new Date().toISOString().slice(0, 10)}`),
);
const experimentId = safeExperimentId(stringArg(args, 'experiment', cluster));
const region = stringArg(args, 'region', 'nyc3');
const project = stringArg(args, 'project', 'agent-sims');
const workerSize = stringArg(args, 'worker-size', 's-2vcpu-4gb');
const controllerSize = stringArg(args, 'controller-size', 's-2vcpu-4gb');
const model = stringArg(args, 'model', 'deepseek/deepseek-v4-flash');
const platform = stringArg(args, 'platform', 'linux/amd64');
const transport = args.mock ? 'mock' : 'openrouter';
const reuseSingleKey = args['reuse-single-key'] === true;
const keyRepeat = numberArg(args, 'key-repeat', 1);
const externalS3 = args['s3-config-file']
  ? z
      .object({
        endpoint: z.string().url(),
        region: z.string().min(1),
        bucket: z.string().min(3),
        accessKeyId: z.string().regex(/^\S+$/),
        secretAccessKey: z.string().regex(/^\S+$/),
        forcePathStyle: z.boolean().default(false),
      })
      .parse(
        JSON.parse(
          await readFile(path.resolve(String(args['s3-config-file'])), 'utf8'),
        ),
      )
  : null;
const gateway = resolveGateway(args.gateway);
const sshPrivateKey = path.resolve(
  String(
    args['ssh-private-key'] ??
      process.env.SSH_PRIVATE_KEY ??
      path.join(os.homedir(), '.ssh/id_ed25519'),
  ),
);
const apply = args.apply === true;
const costCap = Number(args['cost-cap-usd'] ?? 0);

if (apply && (!Number.isFinite(costCap) || costCap <= 0)) {
  throw new Error('--apply requires a positive --cost-cap-usd acknowledgment');
}

const keys =
  transport === 'mock'
    ? Array.from({ length: droplets }, () => '')
    : await readKeys(stringArg(args, 'keys-file'));
const keyAssignment = createKeyAssignmentPlan({
  droplets,
  keyCount: keys.length,
  reuseSingleKey,
  keyRepeat,
});
if (keys.length < keyAssignment.keysNeeded) {
  throw new Error(
    `Need at least ${keyAssignment.keysNeeded} OpenRouter key(s); found ${keys.length}`,
  );
}

const plan = {
  cluster,
  experimentId,
  droplets,
  region,
  project,
  workerSize,
  controllerSize,
  workerConcurrency,
  providerConcurrency,
  simulationType,
  referenceName,
  referenceVersion,
  referenceDir,
  remoteReferenceDir,
  issue: issueFilter,
  maximumConcurrentJobs: droplets * workerConcurrency,
  maximumConcurrentModelCalls: droplets * providerConcurrency,
  model,
  platform,
  transport,
  keyAssignment: keyAssignment.label,
  keysNeeded: keyAssignment.keysNeeded,
  artifactStorage: externalS3 ? 'external-s3' : 'controller-minio',
  costCapUsd: costCap || null,
};
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', plan }, null, 2));
if (!apply) {
  console.log('Add --apply --cost-cap-usd <cap> to create the cluster.');
  process.exit(0);
}

const sshKey = String(args['ssh-key'] ?? (await firstSshKey(gateway)));
const stateFile = statePath(root, cluster);
await mkdir(path.dirname(stateFile), { recursive: true });
try {
  await readFile(stateFile);
  throw new Error(`Cluster state already exists: ${stateFile}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const image = `congressional-direct-vote:${cluster}`;
const archive = path.join(root, '.cluster', `${cluster}-image.tar`);
console.log('Building one immutable worker image...');
await run('docker', ['build', '--platform', platform, '--load', '-t', image, '.'], {
  cwd: root,
});
await run('docker', ['save', '-o', archive, image], { cwd: root });

console.log(`Creating controller and ${droplets} worker droplet(s)...`);
const controllerPromise = createDroplet({
  gateway,
  name: `${cluster}-control`,
  size: controllerSize,
  region,
  project,
  sshKey,
  costCap,
});
const workerPromises = Array.from({ length: droplets }, (_, index) =>
  createDroplet({
    gateway,
    name: `${cluster}-worker-${index + 1}`,
    size: workerSize,
    region,
    project,
    sshKey,
    costCap,
  }),
);
const creationResults = await Promise.allSettled([controllerPromise, ...workerPromises]);
const createdHosts = creationResults
  .filter((result): result is PromiseFulfilledResult<LaunchHost> => result.status === 'fulfilled')
  .map((result) => result.value);
const creationFailure = creationResults.find(
  (result): result is PromiseRejectedResult => result.status === 'rejected',
);
if (creationFailure) {
  await cleanupCreatedHosts(gateway, createdHosts, cluster, stateFile, creationFailure.reason);
  throw creationFailure.reason;
}
if (createdHosts.length !== droplets + 1) {
  const error = new Error(
    `Expected ${droplets + 1} created Droplets but got ${createdHosts.length}`,
  );
  await cleanupCreatedHosts(gateway, createdHosts, cluster, stateFile, error);
  throw error;
}
const controllerHost = createdHosts[0];
if (!controllerHost) throw new Error('Controller Droplet was not created');
const workers = createdHosts.slice(1);
let state: ClusterState = ClusterStateSchema.parse({
  schemaVersion: 1,
  cluster,
  experimentId,
  region,
  image,
  createdAt: new Date().toISOString(),
  controller: { ...controllerHost, privateIp: '0.0.0.0' },
  workers,
});

try {
  await Promise.all(
    [controllerHost, ...workers].map((host) =>
      waitForSsh(host.publicIp, sshPrivateKey),
    ),
  );
  const controllerPrivateIp = (
    await ssh(
      controllerHost.publicIp,
      sshPrivateKey,
      'curl -fsS http://169.254.169.254/metadata/v1/interfaces/private/0/ipv4/address',
    )
  ).trim();
  if (!/^10\.\d+\.\d+\.\d+$/.test(controllerPrivateIp)) {
    throw new Error(`Unexpected controller private address: ${controllerPrivateIp}`);
  }
  state = ClusterStateSchema.parse({
    ...state,
    controller: { ...controllerHost, privateIp: controllerPrivateIp },
  });

  const postgresPassword = randomBytes(24).toString('hex');
  const redisPassword = randomBytes(24).toString('hex');
  const minioUser = `sim${randomBytes(6).toString('hex')}`;
  const minioPassword = randomBytes(24).toString('hex');
  const commonEnv = [
    `DATABASE_URL=postgres://sim:${postgresPassword}@${controllerPrivateIp}:5432/sim_cluster`,
    `REDIS_URL=redis://:${redisPassword}@${controllerPrivateIp}:6379`,
    'QUEUE_NAME=simulation-jobs',
    `S3_ENDPOINT=${externalS3?.endpoint ?? `http://${controllerPrivateIp}:9000`}`,
    `S3_REGION=${externalS3?.region ?? 'us-east-1'}`,
    `S3_BUCKET=${externalS3?.bucket ?? 'simulation-artifacts'}`,
    `S3_ACCESS_KEY_ID=${externalS3?.accessKeyId ?? minioUser}`,
    `S3_SECRET_ACCESS_KEY=${externalS3?.secretAccessKey ?? minioPassword}`,
    `S3_FORCE_PATH_STYLE=${externalS3?.forcePathStyle ?? true}`,
    `OPENROUTER_MODEL=${model}`,
    `OPENROUTER_CONCURRENCY=${providerConcurrency}`,
    `WORKER_CONCURRENCY=${workerConcurrency}`,
    `EXPERIMENT_ID=${experimentId}`,
    `REFERENCE_DIR=${remoteReferenceDir}`,
    `REFERENCE_NAME=${referenceName}`,
    `REFERENCE_VERSION=${referenceVersion}`,
  ];
  const controlEnv = [
    `CONTROL_PRIVATE_IP=${controllerPrivateIp}`,
    'POSTGRES_USER=sim',
    `POSTGRES_PASSWORD=${postgresPassword}`,
    'POSTGRES_DB=sim_cluster',
    `REDIS_PASSWORD=${redisPassword}`,
    `MINIO_ROOT_USER=${minioUser}`,
    `MINIO_ROOT_PASSWORD=${minioPassword}`,
  ].join('\n');

  console.log('Starting the shared Redis, Postgres, and MinIO control plane...');
  await copyToHost(
    path.join(root, 'deploy/docker-compose.control.yml'),
    controllerHost.publicIp,
    sshPrivateKey,
    '/opt/openrouter-sim/docker-compose.yml',
  );
  await copyToHost(archive, controllerHost.publicIp, sshPrivateKey, '/opt/openrouter-sim/image.tar');
  await writeRemoteFile(
    controllerHost.publicIp,
    sshPrivateKey,
    '/opt/openrouter-sim/control.env',
    `${controlEnv}\n`,
  );
  await writeRemoteFile(
    controllerHost.publicIp,
    sshPrivateKey,
    '/opt/openrouter-sim/app.env',
    `${commonEnv.join('\n')}\nSIMULATION_TRANSPORT=mock\n`,
  );
  await sshScript(
    controllerHost.publicIp,
    sshPrivateKey,
    [
      'set -euo pipefail',
      'docker load -i /opt/openrouter-sim/image.tar',
      'cd /opt/openrouter-sim',
      `docker compose --env-file control.env up -d postgres redis${externalS3 ? '' : ' minio'}`,
      'for i in $(seq 1 120); do docker compose --env-file control.env exec -T postgres pg_isready -U sim -d sim_cluster >/dev/null 2>&1 && exit 0; sleep 2; done',
      'exit 1',
    ].join('\n'),
  );

  console.log('Installing the same image and one isolated OpenRouter key on each worker...');
  await Promise.all(
    workers.map(async (worker, index) => {
      await copyToHost(archive, worker.publicIp, sshPrivateKey, '/opt/openrouter-sim/image.tar');
      await writeRemoteFile(
        worker.publicIp,
        sshPrivateKey,
        '/opt/openrouter-sim/worker.env',
        `${commonEnv.join('\n')}\nSIMULATION_TRANSPORT=${transport}\nWORKER_ID=${cluster}-worker-${index + 1}\n${
          transport === 'openrouter'
            ? `OPENROUTER_API_KEY=${keys[keyAssignment.workerKeyIndex(index)]}\n`
            : ''
        }`,
      );
      await sshScript(
        worker.publicIp,
        sshPrivateKey,
        [
          'set -euo pipefail',
          'docker load -i /opt/openrouter-sim/image.tar',
          'docker rm -f simulation-worker >/dev/null 2>&1 || true',
          `docker run -d --name simulation-worker --restart unless-stopped --network host --env-file /opt/openrouter-sim/worker.env ${image} dist/commands/worker.js`,
        ].join('\n'),
      );
    }),
  );

  console.log('Publishing reference data, enqueueing jobs, and starting the finalizer...');
  await sshScript(
    controllerHost.publicIp,
    sshPrivateKey,
    [
      'set -euo pipefail',
      `docker run --rm --network host --env-file /opt/openrouter-sim/app.env ${image} dist/commands/migrate.js`,
      `docker run --rm --network host --env-file /opt/openrouter-sim/app.env ${image} dist/commands/enqueue.js --experiment ${shellQuote(experimentId)} --simulation ${shellQuote(simulationType)} --reference-name ${shellQuote(referenceName)} --reference-version ${shellQuote(referenceVersion)} --reference-dir ${shellQuote(remoteReferenceDir)} --seeds ${seeds} --model ${shellQuote(model)}${issueFilter ? ` --issue ${shellQuote(issueFilter)}` : ''}`,
      'docker rm -f simulation-supervisor >/dev/null 2>&1 || true',
      `docker run -d --name simulation-supervisor --restart on-failure:5 --network host --env-file /opt/openrouter-sim/app.env ${image} dist/commands/supervise.js --experiment ${experimentId}`,
    ].join('\n'),
  );

  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(stateFile, 0o600);
  console.log(
    JSON.stringify(
      {
        status: 'running',
        cluster,
        experimentId,
        stateFile,
        statusCommand: `pnpm cluster:status -- --cluster ${cluster}`,
        downloadCommand: `pnpm cluster:download -- --cluster ${cluster} --output out`,
        destroyCommand: `pnpm cluster:destroy -- --cluster ${cluster} --apply`,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await cleanupFailedLaunch(gateway, state, stateFile, error);
  throw error;
}

async function readKeys(file: string): Promise<string[]> {
  return (await readFile(path.resolve(file), 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      if (/\s/.test(line)) throw new Error('OpenRouter keys cannot contain whitespace');
      return line;
    });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toRemoteAppPath(value: string, argName: string): string {
  if (value.startsWith('/app/')) return value;
  if (path.isAbsolute(value)) {
    throw new Error(`--${argName} must be a repo-relative path or an /app/... path`);
  }
  return `/app/${value.replace(/^\.\//, '')}`;
}

async function firstSshKey(gatewayPath: string): Promise<string> {
  const result = await gatewayRequest(gatewayPath, {
    action: 'digitalocean.ssh_keys_list',
  });
  const first = String(
    (result.resource as { id?: unknown } | undefined)?.id ??
      String(result.outputPreview ?? '').trim().split(/\s+/)[0] ??
      '',
  );
  if (!/^\d+$/.test(first)) {
    throw new Error('No DigitalOcean SSH key found; pass --ssh-key explicitly');
  }
  return first;
}

type LaunchHost = { id: string; name: string; publicIp: string };

async function createDroplet(input: {
  gateway: string;
  name: string;
  size: string;
  region: string;
  project: string;
  sshKey: string;
  costCap: number;
}): Promise<LaunchHost> {
  const result = await gatewayRequest(input.gateway, {
    action: 'digitalocean.droplet_run_cloud_init',
    resourceName: input.name,
    region: input.region,
    size: input.size,
    image: 'ubuntu-24-04-x64',
    scriptPath: 'deploy/bootstrap-host.sh',
    sshKeys: [input.sshKey],
    projectName: input.project,
    tags: ['openrouter-sim', cluster],
    costCapUsd: input.costCap,
  });
  const resource = result.resource as Record<string, unknown> | undefined;
  const id = String(resource?.id ?? '');
  const preview = String(
    (result.phases as { create?: { outputPreview?: unknown } } | undefined)?.create
      ?.outputPreview ?? '',
  );
  const publicIp = publicIpFromResource(resource) ?? preview.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] ?? '';
  if (!/^\d+$/.test(id) || !publicIp) {
    throw new Error(`Could not parse created droplet ${input.name}: ${preview}`);
  }
  return { id, name: input.name, publicIp };
}

async function cleanupCreatedHosts(
  gatewayPath: string,
  hosts: LaunchHost[],
  clusterName: string,
  stateFile: string,
  error: unknown,
): Promise<void> {
  if (hosts.length === 0) return;
  const ids = hosts.map((host) => host.id);
  console.error(
    `Launch failed during Droplet creation: ${error instanceof Error ? error.message : String(error)}`,
  );
  try {
    await gatewayRequest(gatewayPath, {
      action: 'digitalocean.droplets_delete',
      ids,
      costCapUsd: 0,
    });
    console.error(`Deleted partially-created Droplets: ${ids.join(', ')}`);
  } catch (cleanupError) {
    await writeFile(
      stateFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          cluster: clusterName,
          createdAt: new Date().toISOString(),
          failedDuring: 'droplet-creation',
          hosts,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await chmod(stateFile, 0o600);
    console.error(
      `Automatic cleanup failed; wrote partial host recovery data to ${stateFile}. Cleanup error: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`,
    );
  }
}

function publicIpFromResource(resource: Record<string, unknown> | undefined): string | null {
  const direct = resource?.publicIp ?? resource?.public_ip ?? resource?.ip;
  if (typeof direct === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(direct)) {
    return direct;
  }
  const networks = resource?.networks as
    | { v4?: Array<{ type?: unknown; ip_address?: unknown }> }
    | undefined;
  const publicNetwork = networks?.v4?.find((network) => network.type === 'public');
  return typeof publicNetwork?.ip_address === 'string' ? publicNetwork.ip_address : null;
}

async function cleanupFailedLaunch(
  gatewayPath: string,
  state: ClusterState,
  stateFile: string,
  error: unknown,
): Promise<void> {
  console.error(
    `Launch failed after Droplets were created: ${error instanceof Error ? error.message : String(error)}`,
  );
  const ids = [state.controller.id, ...state.workers.map((worker) => worker.id)];
  try {
    await gatewayRequest(gatewayPath, {
      action: 'digitalocean.droplets_delete',
      ids,
      costCapUsd: 0,
    });
    console.error(`Deleted partially-created Droplets: ${ids.join(', ')}`);
  } catch (cleanupError) {
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(stateFile, 0o600);
    console.error(
      `Automatic cleanup failed; wrote recovery state to ${stateFile}. Run pnpm cluster:destroy -- --cluster ${state.cluster} --apply after inspecting the failure. Cleanup error: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`,
    );
  }
}

async function gatewayRequest(
  gatewayPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const output = await run(
    gatewayPath,
    ['run', '--repo', root, '--payload', JSON.stringify(payload)],
    { quiet: true },
  );
  const result = JSON.parse(output) as Record<string, unknown>;
  if (result.status !== 'ok') {
    throw new Error(`Gateway ${String(payload.action)} failed: ${output}`);
  }
  return result;
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

async function waitForSsh(ip: string, privateKey: string): Promise<void> {
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      await run('ssh', [...sshArgs(privateKey), `root@${ip}`, 'test -f /opt/openrouter-sim/BOOTSTRAP_COMPLETE'], {
        quiet: true,
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new Error(`SSH/bootstrap did not become ready for ${ip}`);
}

function ssh(ip: string, privateKey: string, command: string): Promise<string> {
  return run('ssh', [...sshArgs(privateKey), `root@${ip}`, command], { quiet: true });
}

function sshScript(ip: string, privateKey: string, script: string): Promise<string> {
  return run('ssh', [...sshArgs(privateKey), `root@${ip}`, 'bash -s'], {
    input: `${script}\n`,
    quiet: true,
  });
}

function writeRemoteFile(
  ip: string,
  privateKey: string,
  remotePath: string,
  content: string,
): Promise<string> {
  return run(
    'ssh',
    [...sshArgs(privateKey), `root@${ip}`, `umask 077; cat > ${remotePath}`],
    { input: content, quiet: true },
  );
}

function copyToHost(
  local: string,
  ip: string,
  privateKey: string,
  remote: string,
): Promise<string> {
  return run('scp', [...sshArgs(privateKey), local, `root@${ip}:${remote}`], {
    quiet: true,
  });
}
