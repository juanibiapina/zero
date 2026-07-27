# Docs content review — docs.zeroapps.dev (commits 0fc26b2, 02b3fa9)

Hostile first-time-reader review of the eight published pages, cross-checked
against source (`apps/vault-api`, `packages/zerovault-cli`, `packages/errors-core`,
`packages/auth`, `apps/dashboard-web`) and live production. Reviewed the `.md`
twins. Do not edit doc pages from this report; a follow-up stage applies fixes.

## Verdict

**Safe to publish and index, with one gate.** The eight pages are accurate,
concrete, and read as written by someone who used the product, not generated.
Every command, flag, endpoint, header, response shape, host, error code, and
dashboard UI label I could reach checks out against source or live production.
The noindex was correctly lifted from the eight real pages (0fc26b2) while the
still-empty Skills page keeps a page-level `noindex, nofollow`.

The one thing standing between "safe" and "verified safe" is a single
load-bearing claim I could not ground from source: that signing up auto-creates
and activates an organization. The dashboard hard-requires an active Clerk org,
so if that claim is wrong, **every** getting-started path dead-ends immediately
after sign-in. Confirm it with a fresh signup before treating the walkthroughs as
proven (see BLOCKER-1).

- **Factual errors found: 1** (errors/overview grouping description). Details below.
- Everything else verified true.

## Blocker

### BLOCKER-1 — "an organization is created for you and is already active" is unverified and load-bearing

- **Pages:** `vault/getting-started.md` step 1; `vault/overview.md` object model.
- **Claim:** "On sign-up an organization is created for you and is already
  active, shown in the switcher… There is no separate 'create an organization' step."
- **Why it matters:** The dashboard is hard-gated on an active Clerk org. Every
  data page reads `useOrganization()` (`apps/dashboard-web/src/products/vault/pages/ProjectsPage.tsx:17`,
  `KeysPage.tsx:19`, `errors/pages/IssuesPage.tsx:22`) and the Clerk-authed API
  middleware returns `403 {"error":"No active organization"}` when `auth.orgId`
  is absent (`apps/vault-api/src/dashboard-app.ts:98`). If Clerk is not configured
  to force-create and activate an org on signup, a brand-new user lands with no
  active org and the walkthrough dead-ends at step 2 (Projects won't load, keys
  can't be created). Since ZeroErrors keys also come from this same page, the
  ZeroErrors path dies with it.
- **Evidence gap:** The auto-create behavior lives in Clerk dashboard config, not
  the repo. The `user.created` webhook only pings Discord; it does not create an
  org (`apps/vault-api/src/routes/clerk-webhook.ts:25-35`). Nothing in
  `apps/dashboard-web` or `docs/console-auth.md` sets `createOrganization` /
  forces org selection.
- **Fix / resolution:** Confirm by signing up with a never-seen email and
  checking that Projects loads without a manual "create organization" step. If it
  does, close this and keep the wording. If it does not, the getting-started pages
  need an explicit "create your first organization" step and the "already active"
  sentence is false and must go.

## Concern

### CONCERN-1 — Grouping is described as "the first line of the stack trace"; it is the first stack *frame* (1 factual error)

- **Page:** `errors/overview.md`, "Reports and issues": "Grouping is by project, a
  normalized version of the message, and the first line of the stack trace."
- **Truth:** Grouping uses `firstFrame(stack)`, which scans for the first line
  that starts with `at ` and returns that frame, not the literal first line
  (`packages/errors-core/src/fingerprint.ts:35-40`, used at `fingerprint()`
  line 50-58). A typical JS stack's first line is the error type/message, which
  is skipped. A hostile reader who passes a stack whose first line is the message
  will predict grouping wrong.
- **Fix:** "…and the first stack frame (the first `at …` line of the stack)."

## Nits

### Completeness

- **NIT-C1 — ZeroErrors path routes users through the full ZeroVault walkthrough
  for a key.** `errors/getting-started.md` step 1 says "See ZeroVault getting
  started for the walkthrough," but that page is a 4-step vault flow (create
  project, add secret) an errors-only user does not need. The cross-product key
  hop itself is stated honestly (`errors/overview.md` "Keys come from ZeroVault…
  There is no separate key page for ZeroErrors") — that part is well handled. Just
  tell the errors reader they only need sign-in + **API Keys**, e.g. "you only
  need the sign-in and API Keys steps."
- **NIT-C2 — CLI page assumes you already have a key with no path to one.**
  `vault/cli.md` "Authenticate" jumps to `export ZEROVAULT_API_KEY=…` with no link
  to where keys are created. A reader landing directly on this page is stuck. Add
  one line: keys are created in the dashboard under **ZeroVault → API Keys** (link
  to `/vault/getting-started/`).
- **NIT-C3 — CLI overview claims to manage API keys but never shows how.**
  `vault/cli.md` opener: "It manages projects, environments, secrets, and API
  keys." The tool does have `zv keys create/list/revoke`
  (`packages/zerovault-cli/src/index.ts` "keys" section), but the page documents
  none of them. Either document `zv keys` or drop "and API keys" from the claim.
- **NIT-C4 — global install mentioned, command not given.** `vault/cli.md`: "If
  you install it globally you can drop the `pnpm dlx` prefix" — no install command.
  Add `npm i -g zerovault-cli@0.2.2`.

### Writing quality

The prose is strong: specific, imperative, product-informed, no marketing
adjectives, no "seamlessly/powerful/simply", no rule-of-three padding, no
hedging, no challenges-then-hope filler. This does not read as generated. The
offenders are minor.

- **NIT-W1 — placeholder Skills page reads as a stub and leaks internals.** Live
  at `/skills/overview/` and in the sitemap (though `noindex`): "Installable agent
  skills for ZeroVault and ZeroErrors will be listed here. This section will later
  be generated from the repository's top-level `skills/` directory." Future-tense
  promise plus an implementation detail ("generated from the repository's top-level
  `skills/` directory") that means nothing to a user. Prefer to drop it from the
  published sidebar until there is content. If it must ship, rewrite to:
  "ZeroVault and ZeroErrors will ship installable agent skills. None are published
  yet." (Out of the 8-page scope, flagged because it is live and indexed-adjacent.)
- **NIT-W2 — em dash used pervasively as a "label — gloss" separator.** Across
  `index.md`, `vault/overview.md` ("Where things live"), and
  `errors/getting-started.md` ("Errors you may see"). Defensible as a docs
  convention, but the repo house style bans the em dash. Swap for a colon.
  Example, `index.md`:
  - Now: "**[Start with ZeroVault](/vault/getting-started/)** — create a project,
    store a secret, and get an API key."
  - Rewrite: "**[Start with ZeroVault](/vault/getting-started/):** create a
    project, store a secret, and get an API key."
- **NIT-W3 — generic framing opener.** `vault/workers.md`: "A common workflow is
  to keep a Worker's secrets in ZeroVault and push them to Cloudflare when you
  deploy."
  - Rewrite: "Keep a Worker's secrets in ZeroVault and push them to Cloudflare at
    deploy time."
- **NIT-W4 — filler "just".** `vault/cli.md`: "…and just run `zv …`."
  - Rewrite: "…and run `zv …`."

## What was checked and verified true (no action)

Recorded so the fix stage does not re-litigate these.

- **Error codes / headers (live + source):** `401 {"error":"Invalid API key"}`,
  `400 {"error":"Invalid error report"}`, `429` + `Retry-After: 60`; key checked
  before body. `apps/vault-api/src/dashboard-app.ts:62-75`,
  `errors/routes/errors.ts:26-29`. Live: `POST api.zeroapps.dev/errors/v1/errors`
  with a bogus key returns `401 {"error":"Invalid API key"}`.
- **Ingest returns 202 with `{issueId, isNew}`.** `errors/routes/errors.ts:36`,
  `errors/services/ErrorsService.ts:58`, `errors-core/src/index.ts:116-119`.
  `isNew` semantics (true first time, false on regroup) match.
- **Report field limits:** `project` 1–200, `message` 1–10000, `stack` ≤50000,
  `level` enum default `error`, `context` any JSON object. Exactly
  `errors-core/src/index.ts:39-45` and `ErrorsService` default `report.level ?? "error"`.
- **Normalization masks UUIDs / long hex / plain numbers.** `fingerprint.ts:11-30`
  (`UUID_RE`, `HEX_RE` = 8+ hex, `NUM_RE`).
- **Issue model** (`count`, `firstSeenAt`, `lastSeenAt`, `level`, `status`
  open/resolved, `title` = first line of message). `errors-core/src/index.ts:50-60`,
  `ErrorsService.titleOf`. Console: filter by project, Show/Hide resolved toggle,
  per-row and detail-page **Resolve**/**Reopen**, "Recent events", resolve sets
  status without deleting. `errors/routes/issues.ts`,
  `dashboard-web/.../IssuesPage.tsx`, `IssueDetailPage.tsx:70-90`.
- **Errors "project" created implicitly by first report; keys are ZeroVault
  keys, no separate errors key page.** Correct and honestly stated.
- **Hosts / paths:** `api.zeroapps.dev` serves `/vault/v1/*` and `/errors/v1/*`;
  `dash.zeroapps.dev` is the console. `apps/vault-api/src/worker.ts:4-22`, live-confirmed.
- **API keys are organization-scoped** (v2 `{v:2, orgId, userId}`; legacy v1
  rejected). `packages/auth/src/index.ts:17,45-68`, `routes/keys.ts`. Docs' org
  story is correct.
- **CLI (ran `pnpm dlx zerovault-cli@0.2.2`):** package `0.2.2`; `zv --version`
  prints `0.2.1` (stale string, exactly as the docs warn); `zv context add work
  --api-key …` with the trailing global flag works and writes
  `~/.config/zerovault/config.json`; `context use/current/list` behave as
  documented. Auth precedence flag > context > env (`src/index.ts:11-13`,
  `config.resolveAuth`). Config mode 0600 in a 0700 dir (`config.ts:83-85`).
  Command surface (`projects`, `env`, `secrets set/get/list/delete/download`,
  `export/import`, `keys`) and flags (`-p/-e/-f/-o`, `-f env|json|yaml|shell`,
  `download -f json` → flat `{KEY:VALUE}`) all match `src/index.ts`. Default base
  URL `https://api.zeroapps.dev/vault` (`config.ts:155`).
- **`whoami` output** ("User ID: …" / "Org ID: …") matches `src/index.ts:72-73`.
- **`secrets.required` in wrangler.jsonc** fails a real deploy, absent from the
  config schema and `--dry-run`. Matches `docs/workers-ops.md` and the repo's own
  `apps/vault-api/wrangler.jsonc` / `apps/agent-api/wrangler.jsonc`.
- **`wrangler secret bulk` reads flat `{KEY:VALUE}` JSON.** Matches CLI json output.
- **Dashboard UI labels** all match source exactly: "Projects" / "New project
  name" / "Create" (ProjectsPage), "API Keys" / "Label (optional)" / "Create" /
  key-shown-once banner "Copy it now — it won't be shown again" + copy button /
  revoke (KeysPage), Secrets "Save" (SecretsPage), "New environment name"
  (EnvironmentsPage), Issues "Filter by project" / "Show resolved" / "Resolve" /
  "Recent events".
- **Worker reporter** (`errors/worker-integration.md`): endpoint, headers, body
  shape, fire-and-forget/never-throw, `waitUntil` pattern — all consistent with
  the ingest contract.
