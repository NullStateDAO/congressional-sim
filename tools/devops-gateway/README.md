# Bundled DevOps gateway

The `cluster:*` commands never call a provider CLI themselves. They send a JSON
payload naming a policy-allowed action to this process, which is the only thing
in the repo that reads the DigitalOcean token. That keeps the token out of
command lines, out of cluster state, and out of anything the launcher prints.

This is the minimal version: three actions, which is everything
`src/commands/cluster-*.ts` uses. `src/lib/gateway.ts` finds it automatically, so
a fresh clone works with no setup beyond `doctl` and a token.

## Requirements

- Node 22+ (no npm dependencies; the gateway is one file)
- [`doctl`](https://docs.digitalocean.com/reference/doctl/how-to/install/) on `PATH`
- `DIGITALOCEAN_ACCESS_TOKEN` (or `DO_TOKEN`) exported, or set in the repo `.env`

## Actions

| Action | Risk | What it runs |
| --- | --- | --- |
| `digitalocean.ssh_keys_list` | read | `doctl compute ssh-key list` |
| `digitalocean.droplet_run_cloud_init` | mutation | `doctl compute droplet create --wait` with a base64 cloud-init payload, then optional project assignment |
| `digitalocean.droplets_delete` | mutation | `doctl compute droplet delete --force` |

Anything not in [`policies/default-policy.json`](policies/default-policy.json) is
rejected before a child process starts.

## Usage

```bash
node tools/devops-gateway/bin/devops-gateway.mjs catalog

node tools/devops-gateway/bin/devops-gateway.mjs run --repo . --payload '{
  "action": "digitalocean.ssh_keys_list"
}'
```

Every invocation prints one JSON object. `status` is `ok` on success,
`failed` when `doctl` returned non-zero, `blocked_missing_credentials` when no
token was found, and `error` (on stderr, exit 1) when the request itself was
rejected.

## What it enforces

- **Allowlist.** Unknown actions are refused by policy, not by validation later.
- **Argument shape.** Region, size, image, tag, SSH key, and droplet ID values are
  regex-checked before reaching `doctl`, and `doctl` is spawned with an argv
  array, never a shell string.
- **Payload containment.** `scriptPath` must resolve inside `--repo`.
- **Minimal child env.** The `doctl` child gets `PATH`, `HOME`, `LANG`, and the
  credential variables. Nothing else in your environment is inherited.
- **Redaction.** Token values and anything matching `dop_v1_*` are stripped from
  output before printing, and command output is capped at 4000 characters.

## Swapping in your own

Set `DEVOPS_GATEWAY` to any executable that accepts
`run --repo <dir> --payload <json>` and returns the result shape above, or pass
`--gateway <path>` to a `cluster:*` command. The launcher only reads
`status`, `resource.id`, `resource.publicIp`, and `phases.create.outputPreview`.
