# Verify report: `docs-content-getting-started.md`

Adversarial verification of the getting-started content plan against **source
(this repo)** and **live production** (curled 2026-07-27). Every claim below
carries evidence. Ranked blocker / concern / nit.

## Verdict

**Sound. Ship-ready with corrections.** Every load-bearing product fact in the
plan is true against source and production: the hosts, the ZeroErrors ingest
contract, the ZeroVault route shapes, the cross-product key, the CLI surface,
and the cleanup asymmetry all check out. Three things need fixing before or
alongside implementation:

1. The **org blocker is worse than the plan states** — a no-org user gets a
   permanently stuck "Loading…" page, not a blank or a prompt. This warrants a
   small product fix, not just a docs workaround (blocker below).
2. The verify checklist's "bad payload returns **400** … without a key" is
   **impossible** — auth runs before body parse, so no/bad key always yields
   401. The 400 needs a valid key (concern below).
3. The task's framing that "**AGENTS.md and several docs still use** the old
   `vault.apps.` / `errors.apps.` names" is **outdated**: AGENTS.md,
   `docs/secrets.md`, and `docs/console-auth.md` are already on `zeroapps.dev`.
   Stale refs survive only in historical records (concern below).

---

## The true host names (with evidence)

| Host | Status | Evidence |
|---|---|---|
| `api.zeroapps.dev` | **LIVE** | `curl -i https://api.zeroapps.dev/ping` → `HTTP/2 200`, body `{"ok":true}`. Route: `apps/vault-api/wrangler.jsonc` `{ "pattern": "api.zeroapps.dev", "custom_domain": true }`; `worker.ts:5` `API_HOST = "api.zeroapps.dev"`. |
| `dash.zeroapps.dev` | **LIVE** | `curl -o/dev/null -w %{http_code}` → `200`. Route in same wrangler; `worker.ts:4` `DASH_HOST = "dash.zeroapps.dev"`. |
| `docs.zeroapps.dev` | **LIVE** | `curl` → `200`. |
| `vault.apps.juanibiapina.dev` | **DEAD** | `curl` → `Could not resolve host` (NXDOMAIN). Intentionally retired; `apps/vault-api/src/tests/host-dispatch.test.ts:17-22` asserts the worker 404s it. |
| `errors.apps.juanibiapina.dev` | **DEAD** | `curl` → `Could not resolve host` (NXDOMAIN). |

The plan's host facts (`dash.zeroapps.dev`, `api.zeroapps.dev/{vault,errors}/v1`)
are **correct**. The ingest endpoint the plan documents,
`https://api.zeroapps.dev/errors/v1/errors`, matches both live reporters
(`apps/{vault-api,agent-api}/src/reporting/zero-errors.ts`, `const n =
"https://api.zeroapps.dev/errors/v1/errors"`) and the route
(`errors/routes/errors.ts` `app.post("/errors/v1/errors")`).

### Stale references in the repo (corrected picture)

The task said AGENTS.md and current docs are stale. **They are not.**

- **Already migrated (clean):** root `AGENTS.md` (only match is the repo name
  `juanibiapina/zero`), `docs/secrets.md` (`api.zeroapps.dev/vault`,
  `dash.zeroapps.dev/vault`), `docs/console-auth.md` (`zeroapps.dev`,
  `clerk.zeroapps.dev`, `accounts.zeroapps.dev`). The agent's own
  `zero.juanibiapina.dev` in `console-auth.md:12` is correct — it is a separate
  Clerk instance, not a stale console host.
- **Stale but historical (leave or footnote):**
  - `CHANGELOG.md:17-22` — dated entries naming `vault.apps.` / `errors.apps.`
    as where products "live only". Predate the `zeroapps.dev` cutover; a reader
    scanning the changelog is misled. Root CHANGELOG has no in-product surface,
    so low urgency.
  - `docs/workers-ops.md:36` — names `vault.apps.juanibiapina.dev` inside the
    narrative evidence for the *retire-zerovault-domain* event. Historical, but
    that host is itself now dead; a one-word "(since also retired)" would avoid
    confusion.
  - `docs/vault-errors-relocation.md`, `tasks.md`, and all `docs/plans/*` —
    point-in-time plan/record docs; correct to leave untouched.
- **Code (correct, not stale):** `host-dispatch.test.ts:19` uses the old host
  on purpose to assert it is rejected (404). No change needed.

Recommendation: this is beyond the docs task, but at minimum footnote
`CHANGELOG.md:17-22` and `workers-ops.md:36`. Not a docs blocker.

---

## Findings

### BLOCKER

**B1. The no-org first run is a stuck page, not a "prompt with no org" — the
plan understates it, and it needs a product fix.**

The plan's BLOCKER 1 is real and confirmed, but milder than reality. Chain of
evidence:

- Middleware: `apps/vault-api/src/dashboard-app.ts` — `/api/*` returns
  `c.json({ error: "No active organization" }, 403)` when `!auth.orgId`.
  Confirmed. (API-key routes `/vault/v1/*`, `/errors/v1/*` are unaffected: the
  key is already org-scoped, so this only bites the browser UI.)
- First-run route: `apps/dashboard-web/src/main.tsx:26,31,47-48` — index and
  sign-in/up all redirect to `/vault/projects`. No org gate, no org-creation
  step.
- Only org UI: `packages/ui/src/components/AppLayout.tsx` renders Clerk
  `<OrganizationSwitcher>` in the top-right header. **Nothing** auto-creates an
  org, forces org selection, or renders `<CreateOrganization>`. (`SignedOut` →
  `RedirectToSignIn`; that is the only guard.)
- What the user actually sees: `ProjectsPage.tsx:24-30` calls
  `api.listProjects` on mount, then `setLoading(false)` **after** the await.
  `fetchApi` (`packages/ui/src/lib/api.ts:32-37`) throws on `!res.ok`. So on a
  403 the await throws, `load()` rejects (called as `void load()`, unhandled),
  and `setLoading(false)` **never runs** → the page is stuck on **"Loading…"
  forever**, with the create form silently 403ing too. No error, no org prompt.

**Severity:** a brand-new signed-in user **cannot self-serve at all**. Their
only escape is to notice the Clerk org switcher in the corner and create an org
by hand — undiscoverable from the broken projects page. The docs can paper over
it with an explicit "Step 1: click the org switcher, create an organization,"
but they will be documenting a dead-end that most first-time users hit before
reading docs.

**Minimum product fix (pick one, both small):**
- *Preferred:* first-run gate in `AppLayout` — when `useOrganization()` returns
  no active org, render Clerk `<CreateOrganization afterCreateOrganizationUrl=…>`
  (or `<OrganizationList hidePersonal />`) instead of the product `<Outlet/>`.
  One component, one conditional; turns the dead-end into a guided step.
- *Alternative:* auto-create a personal org on first sign-in (Clerk sign-up
  "create organization" step, or a first-run effect calling
  `createOrganization()` + `setActive()`).

Recommend flagging B1 to the approver as a **product fix to land with the docs**,
not merely a documented rough edge.

### CONCERN

**C1. "Bad payload → 400 without a key" is not observable; auth precedes body
parse.**
`dashboard-app.ts` runs the API-key middleware over `/errors/v1/*` **before** the
route handler. A malformed body with no/invalid key returns **401**, never 400.
Verified live: `POST …/errors/v1/errors` with `-d 'not-json'` and a bogus key →
`HTTP/2 401`, body `{"error":"Invalid API key"}`; with no key → same 401. The
route's `400 {error:"Invalid error report"}` (`errors/routes/errors.ts:26-28`)
is only reachable **with a valid key**. Fix the verify checklist: the 400 check
requires a real key (do it against the `docs-demo` project after minting one);
the 401 check needs no key. The docs prose (401 vs 400) is fine.

**C2. The "stale docs" premise is outdated (see host section).** Not a plan
defect — the plan's own facts use `zeroapps.dev` correctly — but the task's
instruction to sweep AGENTS.md/current docs is moot; only historical records
(CHANGELOG, workers-ops narrative) carry dead hosts. Don't rewrite the
`docs/plans/*` history.

**C3. Live 401 body is `{"error":"Invalid API key"}`, not a bare `401`.** The
plan says "bad/absent key → 401" without the shape. Minor, but the errors
getting-started should show the actual body so the reader can recognize a
key problem. Evidence: two live curls above.

### NIT

**N1. CLI `--version` mismatch confirmed.** `packages/zerovault-cli/src/index.ts:58`
hardcodes `.version("0.2.1")`; `npm view zerovault-cli version` = **0.2.2**
(`dist-tags.latest = 0.2.2`). Plan gap 4 is correct: pin `zerovault-cli@0.2.2`,
don't promise `zv --version` prints `0.2.2`. Optional one-line bump.

**N2. Cross-product key: fully confirmed.** `packages/auth/src/index.ts:53-68` —
`validateApiKey` accepts any `zv_` key, rejects non-v2 (`data.v !== 2`), returns
`{orgId, userId}`; the same middleware guards both `/vault/v1/*` and
`/errors/v1/*` (`dashboard-app.ts` loop over both paths). Keys minted as
`zv_${randomHex}`, `prefix = key.slice(0,7)+"..."`, `suffix = key.slice(-4)`
(`OrgDO/index.ts:50-53`). Key UI only in `vaultNav` (`/vault/keys`,
`main.tsx:17`); `errorsNav` is Issues-only (`main.tsx:19`) — **no errors key
UI**. The plan's cross-product note is accurate.

**N3. Cleanup asymmetry confirmed.** No delete route exists in
`apps/vault-api/src/errors/routes/*.ts` (issues can only toggle status; no
project delete) — grep for `delete|DELETE` returns nothing. ZeroVault projects
**are** deletable: `routes/projects.ts:39` `app.delete("/:project")` →
`deleteProject`, `204`/`404`. Plan gap 3 is correct; use a named throwaway
errors project (`docs-demo`) and accept it lingers.

**N4. Ingest contract spot-check passes.** Schema in
`packages/errors-core/src/index.ts:39-47` matches the plan exactly (`project`
1..200, `message` 1..10000, `stack?` ≤50000, `level? enum default error`,
`context?` record). Response is `202` with `{issueId, isNew}`
(`errors/routes/errors.ts:34`, `IngestResponse` at `errors-core:116-118`).
ZeroVault whoami returns `{userId, orgId}` (`dashboard-app.ts` whoami handlers) —
matches the table.

---

## Page count (item 7)

**8 pages is right, not sprawling.** Layout: 1 hub (`index`) + per product
{overview, getting-started, one integration page}. That is the minimum honest
surface for two products with a shared account model. Each page earns its place:
`vault/cli` and `vault/workers` are distinct payoffs; `errors/worker-integration`
is the reason a user adopts ZeroErrors.

**Optional trim to 6** if you want it leaner: fold each short `overview` into the
intro of its `getting-started` (the object model and the grouping model are ~4
paragraphs each). Downside: overviews double as skimmable reference and the
sidebar's "what is this" entry. **Recommendation: keep 8**, but hold the two
overviews to object-model / grouping-model only — no marketing, no duplication of
the getting-started steps. Do **not** add more pages before these ship.

---

## Evidence log (commands run)

- `curl -i https://api.zeroapps.dev/ping` → 200 `{"ok":true}`
- `curl https://dash.zeroapps.dev/` → 200; `https://docs.zeroapps.dev/` → 200
- `curl https://vault.apps.juanibiapina.dev/` / `errors.apps.juanibiapina.dev/`
  → `Could not resolve host` (NXDOMAIN)
- `POST https://api.zeroapps.dev/errors/v1/errors` no key → 401
  `{"error":"Invalid API key"}`; bad key + bad body → 401 (auth first)
- `GET https://api.zeroapps.dev/vault/v1/projects` no key → 401 same body
- `npm view zerovault-cli version` → 0.2.2; `src/index.ts:58` `.version("0.2.1")`
- Source: `apps/vault-api/{wrangler.jsonc,src/worker.ts,src/dashboard-app.ts}`,
  `src/errors/routes/errors.ts`, `src/routes/projects.ts`, `src/OrgDO/index.ts`,
  `packages/{auth,errors-core}/src/index.ts`,
  `apps/dashboard-web/src/{main.tsx,products/vault/pages/ProjectsPage.tsx,products/vault/lib/api.ts}`,
  `packages/ui/src/{components/AppLayout.tsx,lib/api.ts}`
