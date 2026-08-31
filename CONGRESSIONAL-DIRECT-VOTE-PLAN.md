# Congressional Direct-Vote Feasibility Plan

## Decision Summary

Build a new experiment from a fresh clone of the predecessor simulation
cluster repository. Preserve that repository and the `deepseek-v1` artifacts as
an invalid-but-useful diagnostic; do not repair or overwrite that run.

The new experiment will test one inexpensive candidate agent legislature:

- DeepSeek V4 Flash only, using the existing pinned OpenRouter route.
- Exactly one fixed seed.
- One direct vote per historical member and issue.
- No whips, leadership gates, memos, speeches, debate, digests, or procedural
  simulation.
- Simple majority in each applicable chamber; ties fail.
- Exactly three DigitalOcean worker Droplets using the same OpenRouter key.
- BullMQ, PostgreSQL, Docker, DigitalOcean Spaces, retries, resumability, and
  artifact capture inherited from the predecessor cluster repository.
- All 103 issues, not a Senate-passed subset.

This is a cheap feasibility run, not a publication-grade study.

## Question

> Can this simple set of DeepSeek V4 Flash member agents produce direct-majority
> policy decisions that agree with measured national majority opinion more often
> than the real Congress and trivial always-pass or always-block strategies on
> the same 103 historical issues?

The run can support only a descriptive answer about this frozen configuration
and issue set. It cannot establish statistical significance, generalization,
causal superiority, policy quality, or realistic reproduction of congressional
procedure.

## Simple Result Rule

Report four results on the identical 103-issue denominator:

1. Agent legislature concordance.
2. Real Congress concordance: 57/103.
3. Always-pass concordance: 74/103.
4. Always-block concordance: 29/103.

Also report correct counts separately for the 74 public-supported and 29
public-opposed propositions.

Interpret the feasibility result as follows:

- **Positive signal:** agents outperform Congress and the stronger trivial
  baseline, always-pass.
- **Weak/uninteresting signal:** agents outperform Congress but not always-pass.
- **Negative signal:** agents do not outperform Congress.

No p-values, confidence intervals, optimized thresholds, or post-run metric
changes are part of this version.

## Input Contract

### Use the measured proposition, not a legislative vehicle

The model input for each issue must be the paper-derived public-opinion question
already stored as `question_text`. The prompt wraps that text without rewriting
its policy content:

```text
Vote YEA if you support adopting the proposition below.
Vote NAY if you oppose it or prefer the status quo.

<verbatim question_text>
```

Do not give the model a bill number, bill title, whole bill text, amendment,
shell vehicle, generated bill summary, public support percentage, congressional
outcome, or historical roll-call result. Legislative sources may remain in
provenance records but are never simulation context.

This removes the previous wrong-Congress and wrong-bill-version defects from the
execution path instead of trying to make a general bill-text scraper reliable.

### Reference bundle

Create one immutable bundle:

```text
reference/congressional-direct-vote/v1/
  issues.json
  rosters.jsonl
  personas.jsonl
  provenance.json
```

`issues.json` contains:

```json
{
  "issue_id": "dream-act",
  "congress": 115,
  "path": "bicameral",
  "question_text": "Verbatim paper-derived proposition",
  "majority_position": "pass",
  "national_support": 0.74,
  "real_outcome": "not_passed",
  "paper_row_ref": "Appendix Table B.1 row 76"
}
```

Reuse the existing frozen rosters and compiled personas from this repository.
Do not build another roster scraper or persona-generation system. Remove fields
that reveal the tested issue, historical member vote, public polling answer, or
later information before publishing the new bundle.

### Input audit

Before any paid run, one validator must establish:

- Exactly 103 unique issue IDs exist.
- Exactly 57 are coded as real-Congress concordant.
- Exactly 74 have `majority_position=pass`; 29 have `block`.
- Every prompt contains the stored `question_text` verbatim.
- Promptable data contains no national support, real outcome, roll-call result,
  bill identifier, or generated bill package.
- Every issue resolves to the expected House and/or Senate roster.
- Every roster member resolves to exactly one persona.
- Member IDs are unique within each issue/chamber electorate.
- The five known prior source failures are regression fixtures: DREAM Act,
  school gun safety, SCHIP 2007, Normalize Cuba, and late abortion 2006. Their
  prompt snapshots must contain the correct proposition and none of the wrong
  policy text observed in `deepseek-v1`.

Human work is deliberately small: review the prompt template, inspect those five
regression fixtures, and spot-check 15 deterministically selected issue prompts.
Record that review in the final report; do not create a separate approval system.

## Direct-Vote Procedure

For each issue and each voting member in its applicable chamber or chambers:

1. Load the frozen member persona and verbatim proposition.
2. Make one DeepSeek V4 Flash call.
3. Request strict JSON containing one vote and a short rationale.
4. Persist the complete request, raw response, parsed JSON, model/provider
   metadata, token usage, latency, seed, and retry history.

Response schema:

```json
{
  "vote": "yea",
  "rationale": "Two or three complete sentences, preferably under 90 words."
}
```

Prompt rules:

- `yea` supports adopting the stated proposition.
- `nay` opposes it or retains the status quo.
- Decide from the supplied persona and policy proposition.
- Do not reason about scheduling, cloture, filibusters, presidential action,
  competing bills, or predictions of other members' votes.
- Do not mention the real vote or polling result.

Freeze the exact prompt version, model route, seed, temperature, response schema,
and token ceiling in the experiment manifest. Use seed `0` for every task. A
retry repeats the identical task and seed; retries do not count as more seeds.

If a response remains invalid after the existing bounded retry policy, preserve
all attempts and leave the task failed. Do not silently impute a vote or exclude
the member from the denominator. Finalization requires every expected member
vote to be complete.

## Aggregation

- **House:** passes when `yea > seated_voting_members / 2`.
- **Senate:** passes when `yea > seated_voting_members / 2`.
- **Tie:** fails.
- **Bicameral issue:** passes only if both applicable chambers pass.
- **Senate-only issue:** uses only the Senate result.

This is explicitly a **direct-majority agent legislature**. It does not model
cloture or the filibuster. The previous universal 60-vote threshold is removed
because it conflated cloture with final passage and is outside this simplified
question.

For every issue, publish House and Senate tallies, chamber outcomes, final
policy outcome, public-majority label, and concordance. The analysis must be a
pure deterministic reduction over completed vote artifacts.

## Cluster Design

Use the predecessor cluster repository without replacing its infrastructure:

- One controller with Redis and PostgreSQL.
- Existing public DigitalOcean Spaces bucket for references and artifacts.
- Three Dockerized worker Droplets.
- One BullMQ job per member vote.
- Existing deterministic IDs, retries, stalled-job recovery, first-completion
  database writes, status reporting, finalization, and download/destroy flows.

Task identity is the hash of:

```text
simulation version
reference manifest hash
prompt version
issue ID
chamber
member ID
model route
seed 0
```

Do not add Kafka, Kubernetes, another queue, another database, or a web UI.

### Shared OpenRouter key

Make one launcher change: accept a one-line key file with an explicit
`--reuse-single-key` option and install that same key in the root-only worker env
file on all three Droplets. Never put the key in cluster state, command output,
PostgreSQL, Redis, reference data, or artifacts.

Run one worker process per Droplet with worker concurrency `64` and provider
concurrency `64`. Do not add speculative shared-key throttling. Existing retries
and backoff handle transient failures; lower concurrency only if observed 429s,
timeouts, memory pressure, or stalled jobs require it.

## Implementation Sequence

### 1. Create the new repository

- Copy/clone the predecessor cluster repository into a new repository named
  `congressional-direct-vote`.
- Keep its generic hello-world simulation working.
- Add a short note here identifying `deepseek-v1` as invalid for substantive
  interpretation while preserving its artifacts.

Acceptance check: `pnpm check` and `pnpm hello:local` pass in the fresh clone;
the old experiment and public artifact namespace are untouched.

### 2. Build the frozen reference bundle

- Transform the existing 103 issues, rosters, and personas into the minimal
  reference files.
- Add schema validation, leakage checks, exact count checks, and the five
  wrong-policy regression fixtures.
- Publish the content-addressed `v1` reference manifest.

Acceptance check: one `reference:check` command passes every automated input
gate and prints the exact issue/member/job counts.

### 3. Add the direct-vote simulation plugin

- Register `congressional-direct-vote` under `src/simulations/`.
- Implement task expansion, prompt construction, response parsing, and direct
  vote execution using the starter APIs.
- Add deterministic aggregation and baseline reporting.

Acceptance check: fixture tests cover both vote values, malformed JSON, retries,
House/Senate ties, bicameral failure, Senate-only passage, missing votes, task-ID
stability, and all four baseline counts.

### 4. Adapt the launcher for one shared key

- Add `--reuse-single-key` while preserving the starter's existing one-key-per-
  worker behavior as the default.
- Verify three worker env files receive a key without exposing it anywhere else.

Acceptance check: a deployment dry run reports three workers and the expected
total concurrency while showing no secret or key fingerprint.

### 5. Run a free local smoke test

- Run the hello-world path and congressional fixtures with mock model responses.
- Make one live member-vote call only after those checks pass.

Acceptance check: the live response parses, its raw and parsed forms are stored,
and the measured cost per vote produces an acceptable full-run estimate.

### 6. Run one production canary issue

- Launch the real three-Droplet cluster with the production image, shared key,
  reference manifest, and Spaces configuration.
- Enqueue one clearly worded bicameral issue using its final production task IDs.
- Let those completed votes remain part of the full run.

Acceptance check: every expected vote completes, no input leakage appears in the
prompt snapshots, all raw/parsed artifacts are downloadable, aggregation is
schema-valid, rationales discuss the correct proposition, and observed cost is
below the configured run cap.

### 7. Run the remaining issues

- Enqueue the remaining production tasks without deleting the canary votes.
- Observe through `cluster:status`; rely on BullMQ recovery for interruptions.
- Finalize only when every expected vote is complete.
- Download the final bundle before destroying the cluster.

Acceptance check: task count equals the reference-derived expectation, all jobs
are terminal and successful, every issue/chamber has a complete electorate, and
the final manifest pins the exact inputs and configuration.

### 8. Produce the anecdotal report

- Generate machine-readable results and a short Markdown report.
- Apply the predeclared positive/weak/negative rule without changing prompts,
  exclusions, or metrics after seeing the result.
- Publish the report, reference manifest, outcomes, and vote artifacts to the
  public experiment namespace.

Acceptance check: regenerating analysis from downloaded artifacts produces
byte-identical `results.json`, and the Congress/always-pass/always-block counts
are exactly 57, 74, and 29.

## Planned Command Flow

The implementation should support this shape without requiring manual work on
the Droplets:

```bash
# Local validation and one-call smoke
pnpm install
pnpm check
pnpm reference:check
pnpm experiment:smoke -- --simulation congressional-direct-vote

# Dry-run, then launch three workers with one reused key
pnpm cluster:launch -- \
  --cluster congressional-direct-v1 \
  --simulation congressional-direct-vote \
  --droplets 3 \
  --keys-file ~/.config/openrouter-sim/keys.txt \
  --reuse-single-key \
  --worker-concurrency 64 \
  --provider-concurrency 64 \
  --s3-config-file ~/.config/openrouter-sim/spaces.json

pnpm cluster:launch -- \
  --cluster congressional-direct-v1 \
  --simulation congressional-direct-vote \
  --droplets 3 \
  --keys-file ~/.config/openrouter-sim/keys.txt \
  --reuse-single-key \
  --worker-concurrency 64 \
  --provider-concurrency 64 \
  --s3-config-file ~/.config/openrouter-sim/spaces.json \
  --apply

# Production canary retained by the full run
pnpm experiment:enqueue -- \
  --experiment congressional-direct-v1 \
  --simulation congressional-direct-vote \
  --issue <canary-issue>
pnpm cluster:status -- --cluster congressional-direct-v1
pnpm experiment:check -- --experiment congressional-direct-v1 --issue <canary-issue>

# Full run, analysis, download, and cleanup
pnpm experiment:enqueue -- \
  --experiment congressional-direct-v1 \
  --simulation congressional-direct-vote \
  --all
pnpm cluster:status -- --cluster congressional-direct-v1
pnpm finalize -- --experiment congressional-direct-v1
pnpm cluster:download -- --cluster congressional-direct-v1 --output out
pnpm analyze -- --experiment congressional-direct-v1
pnpm cluster:destroy -- --cluster congressional-direct-v1 --apply
```

Exact names may follow the starter's existing command conventions, but the final
README must expose one ordered quickstart with no hidden manual Droplet steps.

## Public Artifacts

Use a new namespace, never `deepseek-v1`:

```text
congressional-direct-vote/v1/
  reference/manifest.json
  experiments/<experiment-id>/manifest.json
  experiments/<experiment-id>/jobs/<job-id>/attempts/<attempt>.json
  experiments/<experiment-id>/outcomes/<issue-id>.json
  experiments/<experiment-id>/results.json
  experiments/<experiment-id>/RESULTS.md
```

Each attempt artifact contains the exact prompt, raw response, parsed vote and
rationale, task identity, model/provider metadata, token usage, latency, and
error information. Public artifacts never contain secrets.

## Explicit Non-Goals

- Multiple models, model comparisons, ensembles, or model search infrastructure.
- More than one production seed.
- Statistical significance, holdouts, causal inference, or publication claims.
- Leadership, whips, debate, cloture, filibusters, committees, amendments,
  conference, or presidential action.
- General bill scraping or generated bill summaries.
- A new persona pipeline, queue, storage service, orchestration layer, or UI.
- Tuning the prompt after the canary based on whether its policy outcome looks
  favorable. A prompt correction creates reference/prompt `v2` and a fresh run.

## Practical Invalidators

Stop and correct the version before continuing if:

- Any agent receives the wrong proposition or answer-key leakage.
- The reference counts or baseline invariants fail.
- Member votes are missing or silently imputed.
- Artifacts omit raw responses or cannot reproduce the final analysis.
- The provider route differs from the frozen DeepSeek configuration.
- The canary exposes systematic parse failures or unrelated rationales.

Rate limits and longer-than-expected runtime are operational problems, not study
invalidators. Address them only if observed.

## Council Provenance

This plan incorporates independent high-reasoning drafts from Anthropic Fable 5
and GPT-5.6 Sol plus a Kimi K3 critical review. The council's automated Fable
merge/final stages could not run because the direct Anthropic account exhausted
its credit balance; the completed drafts and critique were synthesized locally.
