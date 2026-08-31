# Congressional Direct Vote GLM 5.3 Flash Full Run

Captured: 2026-08-26

This run used `z-ai/glm-5.3-flash` (the revealed identity of the retired
`stealth/ox-alpha`) across 8 DigitalOcean worker droplets, with 4 funded
OpenRouter keys assigned twice each, 64 worker / 64 provider concurrency per
droplet (512 concurrent calls total), and a 16384-token response budget for
reasoning plus rationale.

## Outcome

51,623 of 51,625 member-vote jobs completed. The bulk of the run finished in
about 25 minutes at roughly 2,700 completions per minute with no rate
limiting.

The 2 remaining jobs (`normalize-cuba:house:M001177`,
`normalize-cuba:house:G000552`) are unobtainable: Z.AI's upstream content
filter deterministically kills generation on those persona/proposition
combinations (`native_finish_reason: "sensitive"`), returning empty or
truncated content. Each was attempted 46 times. Z.AI is the only OpenRouter
provider for this model, so no alternate route exists. The same filter
transiently affected 38 jobs (36 `normalize-cuba`, 2 `russia-sanction`);
36 eventually passed on retry.

The experiment was finalized with `finalize --allow-incomplete` and analyzed
with `analyze --allow-missing 2`. The analyzer verifies the missing votes are
outcome-invariant: the `normalize-cuba` House tally is 226 nay / 207 yea, so
even two additional yea votes cannot reach the 218 needed to pass.

## Results

- Agent legislature: 65/103 concordant with public majority
- Real Congress: 57/103
- Always pass: 74/103
- Always block: 29/103
- Public-supported propositions: agent correct on 50/74
- Public-opposed propositions: agent correct on 15/29

Per the plan's result rule this is a weak/uninteresting signal: the agent
legislature beats real Congress but not the always-pass baseline.

## Files

- `manifest.json`: finalized manifest, all 51,625 job rows (2 recorded as
  failed with error metadata).
- `results.json` / `RESULTS.md`: analyzer output (`--allow-missing 2`).
- `artifacts.tar.gz`: per-attempt raw responses, parsed votes, and error
  artifacts from controller MinIO.

## Cost

Token totals from the manifest (26.7M prompt, 21.0M completion) correspond to
about $7.30 across the four keys (prompt $0.075/M, completion $0.25/M).
