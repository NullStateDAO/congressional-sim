# Congressional Sim

![Cartoon robots in suits filling a congressional chamber, one at the speaker's podium, with vote tally boards on the walls](robots.png)

Would we be better off if AI agents replaced the humans in Congress?

This repo was a gut check. I had a feeling that congress was so bad they could be replaced by robots. And yes, with super cheap models and a single thinking pass, the agents did better than actual congress. My design was naive and optimized to be cheap so there is still plenty of room to improve. If you're interested, feel free to fork and help me tweak!

We give a cheap LLM agent to every member of the 109th through 117th
Congresses, hand each agent its member's persona (party, state, district,
election margin, stated priorities), and ask it to cast one direct yea/nay vote
on a proposition where national majority opinion was actually measured. No
debate, no whips, no cloture, no amendments, no president. Then we count how
often the agent legislature's outcome agrees with the public majority, and
compare that against what the real Congress did and against two trivial
baselines.

The reference set is 103 propositions with public opinion measurements taken
from Ansolabehere and Kuriwaki's [Collective Representation in
Congress](https://www.cambridge.org/core/journals/perspectives-on-politics/article/collective-representation-in-congress/D935F856F7BEA10A25442C4EF57675ED)
(see [Data sources](#data-sources)), 4,815 member rosters and personas, and
51,625 individual member votes per run. Each agent sees only its own persona and the verbatim
proposition text, and returns JSON with a vote and a short rationale. Seed and
temperature are fixed. The full design, including the invalidators we watch
for, is in [CONGRESSIONAL-DIRECT-VOTE-PLAN.md](CONGRESSIONAL-DIRECT-VOTE-PLAN.md).

## Results

Two complete runs so far, with different models. The scoring rule is simple:
an issue counts as concordant if the simulated legislature's outcome (pass or
block) matches the measured public majority.

| Strategy | DeepSeek run | GLM run |
| --- | ---: | ---: |
| Agent legislature | 64/103 | 65/103 |
| Real Congress | 57/103 | 57/103 |
| Always pass | 74/103 | 74/103 |
| Always block | 29/103 | 29/103 |

Both runs point the same way. The agent legislature beats the real Congress
in each, 64/103 and 65/103 against Congress's 57/103, and two unrelated
models run independently at fixed seed and temperature finish within one
issue of each other. The edge over Congress is not one model's quirk. Each
run cost under $8 of inference. Swap every member of Congress for a
bargain-tier agent, keep the voting rules, and concordance with the measured
public majority goes up.

The honest caveat is the always-pass row. Rubber-stamping everything scores
74/103 because 74 of the 103 propositions had majority public support, so the
sample itself skews popular. But rubber-stamping only wins on that skew: on
the 29 propositions the public opposed, always-pass goes 0 for 29, while the
agents got 17 right (DeepSeek) and 15 (GLM). The agents are discriminating,
and the gap that remains is one narrow, legible behavior: they block too many
popular propositions, passing 47/74 (DeepSeek) and 50/74 (GLM) of the
publicly supported ones. The plan's pre-declared rule reserves "positive
signal" for beating always-pass too, and these runs don't clear that bar yet.
What they do show, twice, with different models, is evidence in the right
direction: replace the members and the legislature tracks the public better
than the real one did.

### What would strengthen the claim

The obvious next levers, roughly in order of cost:

- **Stronger models.** Both runs used flash-tier models; the entire results
  table above cost about $12 of inference. The over-blocking failure mode is
  exactly the kind of thing a frontier-model run could move.
- **More seeds.** One deterministic run per model gives a point estimate.
  Several seeds per model would put a spread on the 64 to 65 and support a
  paired issue-by-issue comparison against the real Congress instead of raw
  totals.
- **Richer personas.** Agents currently see party, district demographics,
  PVI, and mostly party-default platforms (member-specific platform text
  exists for about 6% of personas). District-level opinion or member-specific
  platforms would test whether the over-blocking comes from agents defaulting
  to partisan caution.
- **Add the machinery back.** This design deletes scheduling, whips, and
  debate on purpose. Reintroducing them would show whether deliberation
  closes the gap with always-pass or widens it.
- **A balanced issue set.** The 74/29 pass/block skew is what lets
  always-pass free-ride. A set balanced between popular and unpopular
  propositions makes the trivial baselines honest.

### Run 1: DeepSeek V4 Flash (2026-08-22)

- Model `deepseek/deepseek-v4-flash`, temperature 0.2, seed 0, 768-token
  response budget.
- 51,625/51,625 votes complete. Totals: 29,889 yea, 21,736 nay.
- 31.3M prompt tokens, 12.9M completion tokens, about $4.60 of inference.

### Run 2: GLM 5.3 Flash (2026-08-26)

- Model `z-ai/glm-5.3-flash`, temperature 0.2, seed 0, 16,384-token response
  budget so the model's reasoning phase has room before it emits JSON. This is
  the model OpenRouter served as `stealth/ox-alpha` during its free preview.
- 8 worker droplets, 2 per OpenRouter key across 4 keys, 512 concurrent
  calls. The bulk of the run finished in about 25 minutes at roughly 2,700
  votes per minute.
- 51,623/51,625 votes complete. Totals: 30,353 yea, 21,270 nay. 26.7M prompt
  tokens, 21.0M completion tokens, about $7.30 of inference.

One caveat on the GLM run, and it deserves the flag. Z.AI's upstream content
filter refused two specific House member votes on the Cuba normalization
proposition, killing generation mid-response with `finish_reason: "sensitive"`
on all 46 attempts each. Z.AI is the only provider serving this model, so
those two votes are unobtainable. The same filter transiently hit 36 other
votes on the Cuba and Russia-sanction propositions before retries got through.
We finalized the run with the two votes recorded as missing, and the analyzer
proves they cannot matter: the Cuba House tally is 226 nay to 207 yea, so even
two extra yeas fall short of the 218 needed to pass. Still, it is worth
knowing that a provider's content policy can quietly delete specific
legislators from specific votes. The censorship was not evenly distributed.

## Data sources

The propositions and the benchmark both come from one paper:

- Stephen Ansolabehere and Shiro Kuriwaki, ["Collective Representation in
  Congress"](https://www.cambridge.org/core/journals/perspectives-on-politics/article/collective-representation-in-congress/D935F856F7BEA10A25442C4EF57675ED),
  *Perspectives on Politics* (2025). Also available as a
  [PDF on the author's site](https://www.shirokuriwaki.com/papers/congress.pdf).

The paper codes 103 major issues from 2006 through 2022 with the national
majority position, measured from CES survey data, and whether Congress's
action matched it. Our verbatim proposition text, the public-majority coding,
and the real Congress's 57/103 all come from its Appendix Table B.1, and
every issue in the frozen reference bundle records the row it came from.

Rosters and personas are assembled from public records: member rosters and
IDs from
[unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators),
district demographics from the Census Bureau's American Community Survey, and
campaign platform text from [CampaignView](https://www.campaignview.org/)
where available, with party-default platforms otherwise.

## Artifacts

Everything is public, per-vote, in a DigitalOcean Spaces bucket. Each run
directory has `README.md` (run notes), `RESULTS.md`, `results.json`,
`manifest.json` (every job row with tokens, latency, and status), and
`artifacts.tar.gz` (per-attempt raw model responses and parsed votes).

DeepSeek V4 Flash run:

- [README](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-v1-deepseek-v4-flash-2026-08-22/README.md)
- [RESULTS.md](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-v1-deepseek-v4-flash-2026-08-22/RESULTS.md)
- [results.json](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-v1-deepseek-v4-flash-2026-08-22/results.json)
- [manifest.json](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-v1-deepseek-v4-flash-2026-08-22/manifest.json) (55 MB)
- [artifacts.tar.gz](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-v1-deepseek-v4-flash-2026-08-22/artifacts.tar.gz) (74 MB)

GLM 5.3 Flash run:

- [README](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-glm-flash-v1-2026-08-26/README.md)
- [RESULTS.md](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-glm-flash-v1-2026-08-26/RESULTS.md)
- [results.json](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-glm-flash-v1-2026-08-26/results.json)
- [manifest.json](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-glm-flash-v1-2026-08-26/manifest.json) (64 MB)
- [artifacts.tar.gz](https://agent-sims-congressional-public.nyc3.digitaloceanspaces.com/congressional-direct-vote/saved-runs/congressional-direct-glm-flash-v1-2026-08-26/artifacts.tar.gz) (85 MB)

The same files are committed under [saved-runs/](saved-runs/).

## Run it yourself

You need Node 22+, pnpm, Docker, and an OpenRouter API key with a few dollars
on it. The frozen reference bundle (issues, rosters, personas) is committed in
this repo, so there is nothing to scrape or export.

```bash
pnpm install
pnpm reference:check   # validates the frozen 103-issue bundle
pnpm check             # typecheck + tests
pnpm hello:local       # free end-to-end smoke test of the queue/worker path
```

Start the local infrastructure (Postgres, Redis, MinIO) and run a one-issue
canary. The `cafta` issue is 535 votes and costs a few cents:

```bash
pnpm infra:up
pnpm db:migrate

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

pnpm worker            # processes the queue; ctrl-c when status shows complete
pnpm status
```

Drop the `--issue cafta` flag to enqueue all 51,625 votes into the same
experiment (already-done jobs are skipped). A single local worker at default
concurrency will take a long while; raise `WORKER_CONCURRENCY` and
`OPENROUTER_CONCURRENCY`, or use the cluster commands below.

Finalize and analyze. The experiment tracks all 51,625 expected votes even
when you only enqueued the canary, so a canary-only finalize needs
`--allow-incomplete`:

```bash
pnpm finalize -- --experiment my-canary --allow-incomplete --output out/my-canary-manifest.json
pnpm analyze -- \
  --manifest out/my-canary-manifest.json \
  --reference-dir reference/congressional-direct-vote/v1 \
  --issue cafta \
  --output out/my-canary-analysis
```

`analyze` writes `results.json` and a human-readable `RESULTS.md`. If a
provider content filter permanently blocks votes, as Z.AI's did, `finalize`
accepts `--allow-incomplete` and `analyze` accepts `--allow-missing N`. The
analyzer only tolerates missing votes when it can prove the chamber outcome is
the same no matter how they would have voted; otherwise it refuses.

For a full run in under an hour, the `cluster:*` commands build a Docker
image, launch a controller plus N worker droplets on DigitalOcean through a
typed DevOps gateway, fan the votes out over multiple OpenRouter keys, and
download the artifacts when done. The GLM run above used `--droplets 8
--key-repeat 2 --worker-concurrency 64 --provider-concurrency 64`. Start with
`pnpm cluster:launch` (dry-run by default) and read the plan doc before
spending real money.

That path needs `doctl` on your `PATH` and a DigitalOcean token in
`DIGITALOCEAN_ACCESS_TOKEN`. Nothing else: the gateway it talks to is bundled at
[tools/devops-gateway/](tools/devops-gateway/), has no npm dependencies, and is
found automatically.

## The DevOps gateway

No code under `src/` calls a provider CLI. The `cluster:*` commands send a JSON
payload naming a policy-allowed action to a small gateway process, which is the
only thing that reads the DigitalOcean token. It validates every argument
against an allowlist before spawning `doctl` with an argv array, gives the child
a minimal environment, and redacts token values out of everything it prints. So
the token stays out of command lines, out of cluster state, and out of run
artifacts.

The bundled implementation supports the three actions the launcher uses: list
SSH keys, create a droplet from a cloud-init payload, and delete droplets. See
[tools/devops-gateway/README.md](tools/devops-gateway/README.md) for the request
and result shapes, or to swap in your own via `DEVOPS_GATEWAY`.

## Agent skills

Two [Claude Code](https://claude.com/claude-code) skills ship in
[.claude/skills/](.claude/skills/), so a coding agent working in this repo knows
the operational rules without rediscovering them:

- `congressional-sim-local` covers the local path: verify, enqueue, work the
  queue, finalize, analyze, and what to do when a provider filter permanently
  refuses a vote.
- `congressional-sim-cluster` covers the DigitalOcean path: dry-run first, cost
  cap acknowledgment, key fan-out, cleaning up a failed launch, and the secret
  handling rules to preserve.

They are plain Markdown and are useful to read directly whether or not you use
an agent.
