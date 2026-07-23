# Verify: Swap Tavily DEV key for a PRODUCTION key

Reviewed `docs/plans/tavily-prod-key.md` against the repo, the ZeroVault CLI (0.2.0), the live Tavily API, and wrangler. Verdict: **GO with fixes** — the plan is technically correct; the fixes are safety/leak hardening and honest verification wording, not corrections of fact.

Counts: **1 blocker, 3 concerns, 3 nits.**

## Verified correct (proven, not assumed)

- **Env var + read path.** `apps/agent-api/src/UserDO/index.ts:233` — `const fetcher = createTavilyFetcher(this.env.TAVILY_API_KEY);`. Adapter `apps/agent-api/src/pagefetch/tavily.ts` POSTs to `https://api.tavily.com/extract` with `Authorization: Bearer ${apiKey}`, body `{ urls: url, extract_depth: "basic", format: "markdown" }`, throws `TAVILY_API_KEY not configured` on empty key before any HTTP. Single read site (grep of `apps`/`packages`). Matches the plan exactly.
- **Type decls already present.** `worker-configuration.d.ts:25` and `:44` list `TAVILY_API_KEY` in `Env` and `ProcessEnv`. Value-only swap needs no regen. Correct.
- **CLI 0.2.0 syntax.** `secrets set <KEY=VAL> -p -e`, `secrets get <key> -p -e`, `secrets list -p -e`, `secrets download -p -e --format json` all exist in 0.2.0 with the flags the plan uses. Confirmed via `--help`.
- **Premise holds.** Both `zero-api/development` and `zero-api/production` currently store the **same** `tvly-dev-` key (58 chars). Prod really is running a dev-tier key; the swap is warranted.
- **Verification method is sound.** Ran the plan's exact curl against the current key: **HTTP 200**. Body shape (`urls` as a string) and Bearer auth match the adapter, so a 200 here is a faithful proxy for what the worker does.
- **No reset risk from bulk.** `wrangler secret bulk` creates/updates keys in the payload and only deletes on explicit `null`; secrets absent from the payload are left intact. Re-uploading is idempotent.
- **`.dev.vars` is gitignored** (`git check-ignore` passes) — `bin/fetch-secrets` output can't be committed by accident.
- **No repo change / no changelog: correct.** Value-only swap, single read path, decls already present, no user-observable behavior change (see nit on this). Nothing to edit, nothing to log.

## Blocker

### B1. Step 2 pastes the raw key onto the command line → leaks into shell history + agent transcript
`secrets set TAVILY_API_KEY=<KEY> ...` with the literal value substituted inline writes the secret into shell history, the process table, and (when an agent runs it) the visible transcript. The plan's own rule "never echo the key into logs or the transcript" contradicts the literal command it ships. `secrets set` has no stdin path, so the value must reach it as an argument — but via a shell variable, not inline text.

**Fix.** Read the key into a non-echoed var once, reference it by name everywhere (history stores the literal `"$KEY"`, not the value):
```bash
read -rs KEY; echo            # paste key, hidden; or KEY=$(cat /path/to/keyfile)
pnpm dlx zerovault-cli@0.2.0 secrets set "TAVILY_API_KEY=$KEY" -p zero-api -e development
pnpm dlx zerovault-cli@0.2.0 secrets set "TAVILY_API_KEY=$KEY" -p zero-api -e production
unset KEY
```
Do not run under `set -x`. This is the one hard defect; everything else is a concern or nit.

## Concerns

### C1. `bin/sync-secrets-to-cloudflare` blast radius is 3 live workers, not 1 — the plan only describes the agent worker
The script uploads prod secrets to **three** deployed workers in one run: `zero-api` (agent), `zerovault` (vault-api), and `zeroerrors` (errors-api). The plan describes only the agent-worker portion, so a reader underestimates what the command touches. Bulk merges (C1 is not a reset risk), but if any vault/errors prod value in ZeroVault has drifted from what's live, this run silently pushes those too, to unrelated production workers.

**Fix.** To scope the change to just the agent worker, run only the first block instead of the whole script:
```bash
pnpm dlx zerovault-cli@0.2.0 secrets download -p zero-api -e production --format json \
  | pnpm --dir apps/agent-api exec wrangler secret bulk
```
If running the full script, state explicitly that vault + errors prod secrets are re-pushed and confirm those ZeroVault projects are in sync with live first.

### C2. Verification proves "key stored + valid," not "prod worker swapped" — acceptance criterion overclaims
`wrangler secret list` prints names only. `TAVILY_API_KEY` already exists, so the list output is **byte-identical before and after** the swap; it cannot show that the value changed or was "sourced from the new value" (as the acceptance criteria claim). The live curl (step 4.2) proves the *new key* is valid at Tavily, not that the *running prod worker* uses it. `secret bulk` updates the live worker immediately, so the swap does take effect without a deploy — but the only **direct** end-to-end proof is the step-4 `read_page` round trip through the prod agent (or local worker after `fetch-secrets`).

**Fix.** Reword the acceptance criterion: `secret list` confirms *presence*, not value. Promote the prod `read_page` round trip from "optional" to the required proof-of-swap, or explicitly accept "stored + valid key + successful bulk upload" as the bar and drop the "sourced from the new value" wording that `secret list` can't support.

### C3. No rollback note
If the new prod key is bad/rate-limited, recovery is: re-`set` the old value in ZeroVault and re-run the sync. The old `tvly-dev-` value is currently in both envs; once overwritten it's gone from ZeroVault. Capturing the current value into a temp var before overwrite (then discarding after success) gives a one-command rollback. Minor, but cheap insurance for a live-worker change.

## Nits

### N1. zerovault-cli version drift (docs 0.1.0 vs scripts 0.2.0) — no impact
The plan already flags this and chooses 0.2.0. Verified: 0.2.0 supports every subcommand/flag the plan uses. Harmless for this task. Optionally fix `docs/secrets.md` to 0.2.0 in a separate change; out of scope here.

### N2. "production key is not prefixed `tvly-dev-`" is a heuristic, not a guarantee
Tavily dev keys are `tvly-dev-…`; prod keys are `tvly-…`. The prefix check is a reasonable sanity gate but not authoritative. The live 200 is the real acceptance signal; keep relying on that, not the prefix.

### N3. "No changelog" is defensible but arguable
The AGENTS changelog policy covers "changed behavior." Higher rate limits are user-observable only for users who were hitting the dev-tier ceiling. Skipping the entry is reasonable (same tool, same responses); noting the judgment is enough. No action required.

## Bottom line
**GO** once B1 (inline-key leak) is applied. Fold in C1 (scope the sync or document the 3-worker blast radius) and C2 (honest verification wording; run the prod `read_page` round trip as the real proof). C3 and the nits are optional. Plan facts are accurate and the verification path is proven live (curl → 200).
