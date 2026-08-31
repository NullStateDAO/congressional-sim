---
name: congressional-sim-local
description: Run the congressional direct-vote simulation on one machine. Use for the free mock smoke test, a cheap single-issue canary against OpenRouter, a full local run, and the finalize/analyze steps that turn completed votes into results.json and RESULTS.md.
license: MIT
---

# congressional-sim-local

Drives the local path end to end: queue up member votes, work them off, then
reduce completed votes to a results table. No cloud account needed. For the
DigitalOcean fan-out, use `congressional-sim-cluster` instead.

Requires Node 22+, pnpm, and Docker. Everything past the smoke test also needs
an OpenRouter key with a few dollars on it.

## Order of operations

Never skip step 1. It costs nothing and catches a broken checkout before any
money is spent.

### 1. Verify the checkout

```bash
pnpm install
pnpm reference:check   # validates the frozen 103-issue bundle
pnpm check             # typecheck + tests
pnpm hello:local       # free end-to-end mock run of the queue/worker path
```

`reference:check` recomputes the bundle hash. If it fails, the reference data
was modified and every downstream result is untrustworthy. Stop and report it,
do not regenerate the bundle to make the check pass.

### 2. Start infrastructure

```bash
pnpm infra:up          # Postgres, Redis, MinIO
pnpm db:migrate
```

The ports are non-default (45432, 46379, 49000) so they do not collide with
other local services. `pnpm infra:down` stops them; `pnpm infra:reset` also
drops the volumes and therefore every recorded vote.

### 3. Enqueue

Always canary one issue first. `cafta` is 535 votes and costs a few cents.

```bash
export SIMULATION_TRANSPORT=openrouter
export OPENROUTER_API_KEY=sk-or-...

pnpm experiment:enqueue -- \
  --experiment my-canary \
  --simulation congressional-direct-vote \
  --reference-name congressional-direct-vote \
  --reference-version v1 \
  --reference-dir reference/congressional-direct-vote/v1 \
  --seeds 1 \
  --model z-ai/glm-5.3-flash \
  --issue cafta
```

Drop `--issue` to enqueue all 51,625 votes. Job IDs are deterministic hashes of
(simulation version, reference hash, prompt version, issue, chamber, member,
model, seed), so re-enqueueing the same experiment skips completed work instead
of duplicating it. That makes resuming safe and re-runs cheap.

### 4. Work the queue

```bash
pnpm worker            # ctrl-c once status reports complete
pnpm status
```

One local worker at default concurrency is slow for a full run. Raise
`WORKER_CONCURRENCY` and `OPENROUTER_CONCURRENCY` before reaching for the
cluster. Watch `pnpm status` for the completed/failed split rather than
tailing worker logs.

### 5. Finalize and analyze

An experiment tracks all 51,625 expected votes even when only a canary was
enqueued, so a canary needs `--allow-incomplete`:

```bash
pnpm finalize -- --experiment my-canary --allow-incomplete \
  --output out/my-canary-manifest.json

pnpm analyze -- \
  --manifest out/my-canary-manifest.json \
  --reference-dir reference/congressional-direct-vote/v1 \
  --issue cafta \
  --output out/my-canary-analysis
```

`analyze` writes `results.json` and `RESULTS.md`.

## Missing votes

A provider content filter can permanently refuse specific persona/proposition
pairs. Z.AI did this on two Cuba-normalization House votes during the GLM run.
`analyze --allow-missing N` tolerates up to N of them, but only when it can
prove the chamber outcome is identical however those votes would have gone.
If it cannot prove that, it refuses, and the correct response is to report the
refusal rather than raise N until the number goes through.

## Interpreting results

The scoring rule is pre-declared in
[CONGRESSIONAL-DIRECT-VOTE-PLAN.md](../../../CONGRESSIONAL-DIRECT-VOTE-PLAN.md):
an issue is concordant when the simulated legislature's outcome matches the
measured public majority, on the same 103-issue denominator for all four
strategies. Report the agent legislature, the real Congress, always-pass, and
always-block together. The always-pass baseline scores 74/103 because the
sample skews popular, so an agent number that beats Congress but not always-pass
is a partial result and should be described that way.
