#!/usr/bin/env node
// Minimal typed DevOps gateway for the cluster:* commands.
//
// The cluster launcher never shells out to a provider CLI directly. It sends a
// JSON payload naming a policy-allowed action, and this process is the only
// thing that touches the DigitalOcean token. Secret values are read from the
// environment, passed to a `doctl` child in a minimal env, and redacted out of
// everything this process prints.
//
// Contract:
//   devops-gateway catalog
//   devops-gateway run --repo <dir> --payload '<json>'
//   devops-gateway run --repo <dir> --json <request.json>
//
// Every result is one JSON object on stdout with a `status` field. `ok` means
// the action succeeded; anything else means it did not.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TOOL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const POLICY_PATH = path.join(TOOL_ROOT, 'policies', 'default-policy.json');
const DO_SECRET_NAMES = ['DIGITALOCEAN_ACCESS_TOKEN', 'DO_TOKEN'];

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'help';
const repoDir = path.resolve(args.repo ?? process.cwd());

try {
  if (command === 'help' || args.help) usage();
  loadRepoEnv();
  const policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
  if (command === 'catalog') {
    printJson(catalog(policy));
  } else if (command === 'run') {
    printJson(await runAction(policy, await readRequest(args)));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        schemaVersion: 'devops-gateway.error.v1',
        generatedAt: new Date().toISOString(),
        status: 'error',
        error: redact(error instanceof Error ? error.message : String(error)),
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

function usage() {
  console.log(
    [
      'usage: devops-gateway catalog',
      "       devops-gateway run --repo <dir> --payload '<json>'",
      '       devops-gateway run --repo <dir> --json <request.json>',
      '',
      'Requires doctl on PATH and DIGITALOCEAN_ACCESS_TOKEN (or DO_TOKEN) in the',
      'environment. Secret values are never printed.',
    ].join('\n'),
  );
  process.exit(0);
}

// Fills in provider credentials from <repoDir>/.env when the shell does not
// already export them. Parsed as plain KEY=VALUE, never sourced through a
// shell, and only the names this gateway knows about are read.
function loadRepoEnv() {
  const file = path.join(repoDir, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (!DO_SECRET_NAMES.includes(name) || process.env[name]) continue;
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/s, '$2');
    if (value) process.env[name] = value;
  }
}

function catalog(policy) {
  return {
    schemaVersion: 'devops-gateway.catalog.v1',
    generatedAt: new Date().toISOString(),
    repoDir,
    actions: Object.fromEntries(
      Object.entries(policy.actions).map(([name, def]) => [
        name,
        {
          risk: def.risk,
          credentialRefs: def.credentialRefs ?? [],
          costCapUsd: def.costCapUsd ?? null,
        },
      ]),
    ),
    credentialRefs: Object.keys(policy.credentialRefs),
  };
}

async function runAction(policy, request) {
  if (!request?.action) throw new Error('run request requires action');
  const action = String(request.action);
  const def = policy.actions[action];
  if (!def) throw new Error(`Action is not allowed by policy: ${action}`);

  const cap = Number(request.costCapUsd ?? def.costCapUsd ?? policy.maxDefaultCostUsd ?? 0);
  if (!Number.isFinite(cap) || cap < 0) throw new Error('costCapUsd cannot be negative');

  const credentials = credentialsForAction(policy, def);
  if (credentials.missing.length) {
    return resultBase(action, 'blocked_missing_credentials', {
      provider: providerFromAction(action),
      credentialRefs: def.credentialRefs ?? [],
      missingCredentialRefs: credentials.missing,
      missingEnvNames: credentials.missingEnvNames,
    });
  }
  return execute(action, request, credentials.env, def);
}

async function execute(action, request, credentialEnv, def) {
  const env = normalizeAliases(credentialEnv);

  if (action === 'digitalocean.ssh_keys_list') {
    return doctl(action, ['compute', 'ssh-key', 'list', '--format', 'ID,Name,FingerPrint', '--no-header'], env, def);
  }

  if (action === 'digitalocean.droplets_delete') {
    const ids = dropletIds(request);
    const phase = doctl(action, ['compute', 'droplet', 'delete', ...ids, '--force'], env, def);
    return resultBase(action, phase.status, {
      provider: 'digitalocean',
      resource: { type: 'droplets', ids },
      phase,
    });
  }

  if (action === 'digitalocean.droplet_run_cloud_init') {
    return createDroplet(action, request, env, def);
  }

  throw new Error(`Action has no implementation: ${action}`);
}

async function createDroplet(action, request, env, def) {
  const name = safeResource(request.resourceName ?? request.name ?? 'agent-runner');
  const region = dropletRegion(request);
  const size = dropletSize(request);
  const image = dropletImage(request);
  const tags = dropletTags(request, name);
  const userData = cloudInitForScript(await dropletScript(request));
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devops-gateway-droplet-'));
  const userDataFile = path.join(tempDir, 'user-data.yaml');
  try {
    await writeFile(userDataFile, userData, 'utf8');
    const argv = [
      'compute', 'droplet', 'create', name,
      '--size', size,
      '--image', image,
      '--region', region,
      '--user-data-file', userDataFile,
      '--wait',
      '--format', 'ID,Name,PublicIPv4,Status,Region,Image,Size,Tags',
      '--no-header',
    ];
    for (const key of dropletSshKeys(request)) argv.push('--ssh-keys', key);
    for (const tag of tags) argv.push('--tag-names', tag);

    const createWithRaw = doctl(action, argv, env, def, { includeRaw: true });
    const columns = String(createWithRaw.outputRaw ?? '').trim().split(/\s+/);
    const { outputRaw: _raw, ...create } = createWithRaw;
    const id = /^\d+$/.test(columns[0] ?? '') ? columns[0] : null;
    const publicIp = columns.find((value) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) ?? null;

    const project =
      create.status === 'ok' && id && (request.projectName || request.projectId)
        ? assignToProject(action, request, env, def, `do:droplet:${id}`)
        : null;

    return resultBase(action, create.status === 'ok' && (!project || project.status === 'ok') ? 'ok' : 'failed', {
      provider: 'digitalocean',
      resource: { id, name, type: 'droplet', publicIp, region, size, image, tags, logPath: '/var/log/agent-payload.log' },
      guidance: {
        execution: 'Payload is installed through cloud-init and runs once on first boot.',
        inspect: "ssh root@<publicIp> 'tail -200 /var/log/agent-payload.log'",
        cleanup: `doctl compute droplet delete ${name} --force`,
      },
      phases: { create, ...(project ? { project } : {}) },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function assignToProject(action, request, env, def, urn) {
  const resolved = resolveProjectId(action, request, env, def);
  if (resolved.status !== 'ok') {
    return { status: 'failed', phase: 'resolveProject', projectName: request.projectName ?? null, resolveProject: resolved };
  }
  const assign = doctl(action, ['projects', 'resources', 'assign', resolved.projectId, '--resource', urn], env, def);
  return {
    status: assign.status,
    projectId: resolved.projectId,
    projectName: resolved.projectName,
    assignedUrn: urn,
    assign,
  };
}

function resolveProjectId(action, request, env, def) {
  if (request.projectId) {
    return { status: 'ok', projectId: String(request.projectId), projectName: request.projectName ?? null };
  }
  const projectName = String(request.projectName ?? '').trim();
  if (!projectName) return { status: 'failed', reason: 'projectName or projectId is required' };

  const list = doctl(action, ['projects', 'list', '--format', 'ID,Name', '--no-header'], env, def, { includeRaw: true });
  const lines = String(list.outputRaw ?? '').split('\n').filter(Boolean);
  delete list.outputRaw;
  const matches = [];
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(.+?)\s*$/);
    if (match && match[2] === projectName) matches.push({ id: match[1], name: match[2] });
  }
  if (matches.length !== 1) {
    return {
      status: 'failed',
      reason: matches.length === 0 ? `No project matched ${projectName}` : `Multiple projects matched ${projectName}`,
      list,
    };
  }
  return { status: 'ok', projectId: matches[0].id, projectName: matches[0].name, list };
}

function doctl(action, argv, env, def, options = {}) {
  const started = Date.now();
  const result = spawnSync('doctl', argv, {
    cwd: repoDir,
    env: minimalEnv(env),
    encoding: 'utf8',
    timeout: Number(def.timeoutMs ?? 300000),
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error('doctl was not found on PATH; install and authenticate the DigitalOcean CLI');
  }
  const outputRaw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const payload = resultBase(action, result.status === 0 ? 'ok' : 'failed', {
    provider: providerFromAction(action),
    command: ['doctl', ...argv].join(' '),
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - started,
    outputPreview: redact(outputRaw.slice(0, 4000)),
  });
  if (options.includeRaw) payload.outputRaw = outputRaw;
  return payload;
}

function resultBase(action, status, extra = {}) {
  return {
    schemaVersion: 'devops-gateway.result.v1',
    generatedAt: new Date().toISOString(),
    action,
    status,
    repoDir,
    ...extra,
  };
}

function credentialsForAction(policy, def) {
  const env = {};
  const missing = [];
  const missingEnvNames = [];
  for (const ref of def.credentialRefs ?? []) {
    const candidates = policy.credentialRefs[ref] ?? [];
    if (!candidates.some((name) => process.env[name])) {
      missing.push(ref);
      missingEnvNames.push(...candidates);
      continue;
    }
    for (const name of candidates) {
      if (process.env[name]) env[name] = process.env[name];
    }
  }
  return { env, missing, missingEnvNames };
}

function normalizeAliases(env) {
  const next = { ...env };
  if (!next.DIGITALOCEAN_ACCESS_TOKEN && next.DO_TOKEN) next.DIGITALOCEAN_ACCESS_TOKEN = next.DO_TOKEN;
  return next;
}

function minimalEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    ...extra,
  };
}

function redact(value) {
  let out = String(value);
  for (const name of DO_SECRET_NAMES) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) out = out.split(secret).join(`[redacted:${name}]`);
  }
  return out.replace(/\bdop_v1_[A-Za-z0-9]{16,}/g, '[redacted:do_token]');
}

function dropletIds(request) {
  const raw = request.ids ?? request.dropletIds ?? request.id ?? [];
  const ids = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((id) => String(id).trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error('Droplet deletion requires ids or dropletIds');
  if (ids.length > 100 || ids.some((id) => !/^\d+$/.test(id))) {
    throw new Error('Droplet IDs must be a list of at most 100 numeric IDs');
  }
  return [...new Set(ids)];
}

function dropletRegion(request) {
  const region = String(request.region ?? process.env.DIGITALOCEAN_REGION ?? 'nyc3').toLowerCase().trim();
  if (!/^[a-z]{2,4}[0-9]$/.test(region)) {
    throw new Error('Droplet region must look like nyc3, sfo3, ams3, fra1, or sgp1');
  }
  return region;
}

function dropletSize(request) {
  const size = String(request.size ?? 's-1vcpu-1gb').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(size)) throw new Error('Droplet size contains invalid characters');
  return size;
}

function dropletImage(request) {
  const image = String(request.image ?? 'ubuntu-24-04-x64').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(image)) throw new Error('Droplet image contains invalid characters');
  return image;
}

function dropletSshKeys(request) {
  const raw = request.sshKeys ?? request.sshKey ?? [];
  return (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((key) => String(key).trim())
    .filter(Boolean)
    .map((key) => {
      if (!/^[A-Za-z0-9:._ -]+$/.test(key)) throw new Error('Droplet SSH key contains invalid characters');
      return key;
    });
}

function dropletTags(request, name) {
  const raw = request.tagNames ?? request.tags ?? [];
  const tags = (Array.isArray(raw) ? raw : String(raw).split(',')).map(safeResource).filter(Boolean);
  return [...new Set(['agent-runner', name, ...tags])].slice(0, 10);
}

async function dropletScript(request) {
  if (request.scriptPath) {
    const resolved = path.resolve(repoDir, String(request.scriptPath));
    const relative = path.relative(repoDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('scriptPath must stay inside --repo');
    }
    if (!existsSync(resolved)) throw new Error(`scriptPath does not exist: ${relative}`);
    return readFileSync(resolved, 'utf8');
  }
  if (typeof request.script === 'string' && request.script.trim()) return request.script;
  throw new Error('droplet_run_cloud_init requires scriptPath or script');
}

function cloudInitForScript(script) {
  const chunks = Buffer.from(script, 'utf8').toString('base64').match(/.{1,76}/g) ?? [''];
  return [
    '#cloud-config',
    'write_files:',
    '  - path: /opt/agent-payload/run.sh',
    '    owner: root:root',
    "    permissions: '0755'",
    '    encoding: b64',
    '    content: |',
    ...chunks.map((line) => `      ${line}`),
    'runcmd:',
    "  - [ bash, -lc, '/opt/agent-payload/run.sh > /var/log/agent-payload.log 2>&1' ]",
    '',
  ].join('\n');
}

function safeResource(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 52) || 'agent-runner'
  );
}

function providerFromAction(action) {
  return action.split('.')[0];
}

async function readRequest(parsedArgs) {
  if (parsedArgs.json) return JSON.parse(readFileSync(path.resolve(repoDir, parsedArgs.json), 'utf8'));
  if (parsedArgs.payload) return JSON.parse(parsedArgs.payload);
  if (parsedArgs.action) {
    return {
      action: parsedArgs.action,
      resourceName: parsedArgs.resource,
      costCapUsd: parsedArgs['cost-cap-usd'],
    };
  }
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  if (stdin.trim()) return JSON.parse(stdin);
  throw new Error('run requires --action, --payload, --json, or stdin JSON');
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) parsed[key] = argv[++i];
    else parsed[key] = true;
  }
  return parsed;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
