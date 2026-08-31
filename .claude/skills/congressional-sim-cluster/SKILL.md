---
name: congressional-sim-cluster
description: Launch, monitor, download, and destroy the DigitalOcean droplet cluster that runs the congressional simulation at full scale. Use for cluster:launch, cluster:status, cluster:download, cluster:destroy, OpenRouter key fan-out, and the bundled DevOps gateway that fronts the DigitalOcean API.
license: MIT
---

# congressional-sim-cluster

A full 51,625-vote run takes a long while on one machine. The `cluster:*`
commands build one immutable Docker image, stand up a controller plus N worker
droplets on DigitalOcean, fan the votes across multiple OpenRouter keys, and
pull the artifacts back. The GLM run finished in about 25 minutes on 8 workers.

This spends real money. Get a local canary passing with
`congressional-sim-local` first.

## Prerequisites

- Docker, Node 22+, pnpm
- [`doctl`](https://docs.digitalocean.com/reference/doctl/how-to/install/) on `PATH`
- `DIGITALOCEAN_ACCESS_TOKEN` (or `DO_TOKEN`) exported or in `.env`
- An SSH key registered with DigitalOcean; the private half defaults to
  `~/.ssh/id_ed25519`, overridable with `SSH_PRIVATE_KEY` or `--ssh-private-key`
- A keys file: one funded OpenRouter key per line, `#` comments allowed

## The gateway

Nothing in `src/` calls `doctl` directly. Droplet actions go through the
bundled gateway at [`tools/devops-gateway/`](../../../tools/devops-gateway/),
which holds the only code that reads the DigitalOcean token, validates every
argument against an allowlist policy, and redacts secrets from its output.
It is found automatically. Override it with `DEVOPS_GATEWAY` or `--gateway`
only when substituting a different implementation.

If a `cluster:*` command reports `blocked_missing_credentials`, the token is not
visible to the gateway. That is a credential problem, not a launcher bug.

## Launch

`cluster:launch` is dry-run by default and prints the full plan: droplet count,
sizes, region, model, concurrency, key assignment, and estimated fan-out. Read
it before adding `--apply`.

```bash
pnpm cluster:launch -- \
  --cluster my-run \
  --experiment my-run \
  --simulation congressional-direct-vote \
  --reference-name congressional-direct-vote \
  --reference-version v1 \
  --droplets 8 \
  --key-repeat 2 \
  --worker-concurrency 64 \
  --provider-concurrency 64 \
  --model z-ai/glm-5.3-flash \
  --keys-file ~/openrouter-keys.txt
```

Add `--apply --cost-cap-usd <cap>` to actually create anything. `--apply` is
refused without a positive cap; that acknowledgment is deliberate, so do not
route around it by picking an arbitrarily large number.

Key fan-out is `--key-repeat N` (each key drives N droplets) or
`--reuse-single-key` (one key for all). The launch fails early if the keys file
has too few keys for the droplet count. The GLM run used 4 keys, `--key-repeat
2`, 8 droplets, 512 concurrent calls.

Launch is atomic in intent: if droplet creation or provisioning fails partway,
it deletes what it created. If that cleanup also fails it writes recovery state
to `.cluster/<name>.json` and tells you to run `cluster:destroy`. Never leave a
failed launch unresolved, droplets bill by the hour.

## Monitor, download, destroy

```bash
pnpm cluster:status   -- --cluster my-run
pnpm cluster:download -- --cluster my-run --output out
pnpm cluster:destroy  -- --cluster my-run --apply
```

A supervisor container on the controller finalizes the experiment when the
queue drains, so `cluster:status` is the thing to poll, not the worker logs.
`cluster:download` pulls the manifest and artifacts out of controller MinIO;
do it before destroying, because destroy takes the controller volume with it.
`cluster:destroy` is also dry-run by default.

## Secret handling

Keep it this way when changing these commands:

- OpenRouter keys go into a root-only env file on the worker that uses them,
  one key per worker, and appear in no other place.
- Postgres, Redis, and MinIO credentials are generated per launch and exist only
  in the controller env file.
- Cluster state under `.cluster/` is written mode 0600 and holds droplet IDs and
  IPs, never keys. It is gitignored.
- Nothing secret reaches command output, the database, Redis, reference data, or
  artifacts.

## Cost

Both published runs cost under $8 of inference each, plus droplet time. The
droplets are the part that keeps billing after you stop paying attention.
Destroy the cluster as soon as the download finishes.
