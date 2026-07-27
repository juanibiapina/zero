# Plan: getting-started content for ZeroVault + ZeroErrors docs (`apps/docs`)

Status: plan only. No code changed. This fills the live Starlight site at
`docs.zeroapps.dev` (currently placeholder + global `noindex, nofollow`, shipped
by `docs/plans/docs-site-scaffold.md`) with real getting-started content for both
products, then removes the site-wide `noindex` and submits the sitemap.

This is a **content plan**. Content only ships if every claim is true. All
product facts below were read from source in this repo (paths cited). The
implementer must additionally **execute every command against production** before
publishing (see the verification checklist).

## Goal

A new user landing on `docs.zeroapps.dev` can, from the docs alone:

1. Understand what ZeroVault and ZeroErrors are and pick one.
2. **ZeroVault:** sign in, get to a working org, create a project, store a
   secret (UI + CLI), and pull secrets into a Cloudflare Worker deploy.
3. **ZeroErrors:** get an API key, POST their first error, and see the issue in
   the console; drop a correct `onError` reporter into a Worker.

Small and true beats encyclopedic. Eight pages total (six new, two rewritten
from placeholder). No feature is documented that does not exist today.

---

## Product facts verified from source

Every fact below is load-bearing for the content and was confirmed by reading
the file cited. Nothing here is assumed.

### Shared platform / auth

- **One dashboard, two products, one origin.** Dashboard is
  `https://dash.zeroapps.dev`; ZeroVault at `/vault/*`, ZeroErrors at
  `/errors/*`, sharing one Clerk session. (`docs/console-auth.md`,
  `apps/vault-api/src/worker.ts` — `DASH_HOST = "dash.zeroapps.dev"`.)
- **Public API host** is `https://api.zeroapps.dev`, serving only `/ping`,
  `/vault/v1/*`, `/errors/v1/*`. (`apps/vault-api/src/worker.ts`.)
- **Clerk instance** for the dashboard has primary domain `zeroapps.dev`
  (frontend `clerk.zeroapps.dev`, account portal `accounts.zeroapps.dev`). The
  agent is a *separate* Clerk instance — do not mention it in dashboard docs.
  (`docs/console-auth.md`.)
- **Sign-in / sign-up** are at `/sign-in` and `/sign-up`; both redirect to
  `/vault/projects` after auth. (`apps/dashboard-web/src/main.tsx` lines 47-48;
  index route redirects `/` → `/vault/projects`.)
- **API keys are org-scoped `zv_` tokens** and are the single credential for
  BOTH products: the same key authorizes `/vault/v1/*` and `/errors/v1/*`. Keys
  are opaque `zv_<hex>`, validated by SHA-256 KV lookup; only v2 (org-scoped)
  keys are valid. (`packages/auth/src/index.ts`;
  `apps/vault-api/src/OrgDO/index.ts` mints `zv_${randomHex}`, stores
  `prefix = key.slice(0,7)+"..."`, `suffix = key.slice(-4)`.)
- **Key management UI lives only under ZeroVault** (`/vault/keys`, nav label
  "API Keys"). ZeroErrors has no key UI, so an errors user gets their ingest key
  from the ZeroVault API Keys page. (`apps/dashboard-web/src/main.tsx`
  `vaultNav` / `errorsNav`.)

### ZeroVault object model + endpoints (all read from `apps/vault-api/src`)

Auth: `/api/vault/*` uses the Clerk session (browser, same-origin);
`/vault/v1/*` uses `Authorization: Bearer zv_...` (API key). Both require an
active org (see BLOCKER 1). Endpoints verified in the route files:

| Method | API-key path (`/vault/v1`) | Browser path (`/api/vault`) | Body / response | Source |
|---|---|---|---|---|
| GET | `/whoami` | — | `{userId, orgId}` | `dashboard-app.ts` |
| GET | `/keys` | `/keys` | `{keys:[{id,prefix,suffix,label?,createdAt}]}` | `routes/keys.ts` |
| POST | `/keys` | `/keys` | body `{label?}` → `201 {key,id,prefix,suffix,label?,createdAt}` (full `key` shown once) | `routes/keys.ts` |
| DELETE | `/keys/:id` | `/keys/:id` | `204` | `routes/keys.ts` |
| GET | `/projects` | `/projects` | `{projects:[{id,name,createdAt}]}` | `routes/projects.ts` |
| POST | `/projects` | `/projects` | body `{name}` → `201 {id,name,createdAt,environments}`; `409` if exists. Auto-creates `development` + `production` envs | `routes/projects.ts`, `ProjectVaultDO/index.ts:76-97` |
| DELETE | `/projects/:project` | `/projects/:project` | `204`; `404` if absent | `routes/projects.ts` |
| GET | `/projects/:project/environments` | same | `{environments:[{id,name,createdAt}]}` | `routes/environments.ts` |
| POST | `/projects/:project/environments` | same | body `{name}` → `201`; `409` if exists | `routes/environments.ts` |
| DELETE | `/projects/:project/environments/:env` | same | `204`; `404` if absent | `routes/environments.ts` |
| GET | `/projects/:project/environments/:env/secrets` | same | `{secrets:[{key,value}]}` (plaintext); `404` if project/env absent | `routes/secrets.ts` |
| PUT | `.../secrets` | same | body `{secrets:[{key,value}]}` full-replace → `{ok:true}` | `routes/secrets.ts` |
| PATCH | `.../secrets` | same | body `{secrets:[{key,value|null}]}` upsert/delete (`null` deletes) → `{ok:true}` | `routes/secrets.ts` |

- **Default environments** on project create: `development` and `production`.
  (`ProjectVaultDO/index.ts:92-93`.)
- **What the UI can do:** create/delete projects (`ProjectsPage.tsx`),
  create/delete environments + edit secrets (`EnvironmentsPage`, `SecretsPage`),
  create/list/revoke API keys with copy-once reveal (`KeysPage.tsx`). No org
  creation page — that is Clerk's `OrganizationSwitcher` only (see BLOCKER 1).

### ZeroVault CLI (`packages/zerovault-cli`)

- **npm:** published latest is `0.2.2` (`npm view zerovault-cli version`);
  `dist-tags.latest = 0.2.2`. AGENTS.md and `docs/secrets.md` both invoke
  `pnpm dlx zerovault-cli@0.2.2`. Bin name is `zv` (`package.json` `bin`).
- **Auth precedence** (first match wins): `--api-key` flag > directory-bound
  context (`zv context use`) > `ZEROVAULT_API_KEY` env. Base URL:
  `--base-url` > context.baseUrl > `ZEROVAULT_API_URL` env >
  default `https://api.zeroapps.dev/vault`. (`src/config.ts`
  `resolveAuth` + `DEFAULT_BASE_URL`; `src/index.ts` `getClient`.)
- Config file: `~/.config/zerovault/config.json` (override `ZEROVAULT_CONFIG`),
  chmod 0600. Stores named contexts + per-dir bindings. (`src/config.ts`.)
- **Commands** (all in `src/index.ts`):
  - `zv whoami`
  - `zv context {list,current,use <name>,unset,add <name> --api-key <k> [--base-url <u>],remove <name>}`
  - `zv projects {list,create <name>,delete <name>}`
  - `zv env {list,create <name>,delete <name>} -p <project>`
  - `zv secrets list|get <key>|set <K=V...>|delete <key> -p <project> -e <env>`
  - `zv secrets download -p <project> -e <env> [-f env|json|yaml|shell] [-o file]`
  - `zv export [-o file]` / `zv import <file>` (whole-vault JSON; plaintext —
    warns to delete after)
  - `zv keys {create [-l label],list,revoke <id>}`
- **Client base-path shape:** client calls `${baseUrl}/v1/...`, and the default
  baseUrl already ends in `/vault`, so requests hit
  `https://api.zeroapps.dev/vault/v1/...`. (`src/client.ts`.) The CLI is
  **ZeroVault-only** — there are no errors commands.

### Worker integration (secrets → deploy)

- `bin/fetch-secrets` + `bin/sync-secrets-to-cloudflare` are this repo's own
  pattern; the generic user pattern is `zv secrets download` piped into
  `wrangler secret bulk` (or writing a `.dev.vars`). (`docs/secrets.md`;
  `zv secrets download -f json` emits `{KEY:VALUE}` which `wrangler secret bulk`
  accepts.)
- **`secrets.required` deploy gate:** adding a secret name to
  `secrets: { required: [...] }` in `wrangler.jsonc` makes `wrangler deploy`
  abort if it is unset, and `wrangler dev` warn. The field is absent from
  wrangler's bundled `config-schema.json` and does not show in
  `--dry-run`; it is enforced only at real deploy. Live examples:
  `apps/vault-api/wrangler.jsonc`, `apps/agent-api/wrangler.jsonc`
  (`["ZEROVAULT_API_KEY"]`). (`docs/workers-ops.md`.)

### ZeroErrors ingest + model (`apps/vault-api/src/errors`, `packages/errors-core`)

- **Ingest endpoint (VERIFIED, and the task's note was WRONG):** real endpoint is
  **`POST https://api.zeroapps.dev/errors/v1/errors`**, NOT
  `errors.apps.juanibiapina.dev/v1/errors`. Confirmed against the two live
  reporters (`apps/vault-api/src/reporting/zero-errors.ts` and
  `apps/agent-api/src/reporting/zero-errors.ts`, both `ENDPOINT =
  "https://api.zeroapps.dev/errors/v1/errors"`) and the route
  (`errors/routes/errors.ts` `app.post("/errors/v1/errors")`).
- **Auth:** `Authorization: Bearer zv_...` — same org key as ZeroVault.
  (`dashboard-app.ts` middleware over `/errors/v1/*`.)
- **Payload schema** (`packages/errors-core/src/index.ts` `errorReportSchema`):
  ```
  { project: string(1..200),           // required
    message: string(1..10000),         // required
    stack?: string(<=50000),
    level?: "error" | "warning" | "info",   // default "error"
    context?: Record<string, unknown> }
  ```
- **Response:** `202` with `{ issueId: string, isNew: boolean }`. Confirmed
  `IngestResponse` in errors-core and `ErrorsService.report` return.
  Invalid payload → `400 {error:"Invalid error report"}`; bad/absent key →
  `401`; rate-limited → `429` with `Retry-After: 60`.
- **Grouping / fingerprint:** issues group by
  `sha256(project + normalizedMessage + firstStackFrame)`. Normalization masks
  UUIDs → `<uuid>`, long hex → `<hex>`, digits → `<n>`, so per-occurrence ids
  collapse into one issue. Title = first line of message (<=200 chars). Level
  defaults to `error`. (`packages/errors-core/src/fingerprint.ts`,
  `ErrorsService.ts`.)
- **Read/console model:** issues have `{id,fingerprint,project,title,level,
  status,count,firstSeenAt,lastSeenAt}`. Console shows a filterable issue list
  (filter by project, toggle show-resolved) and an issue detail with events;
  status toggles open ⇄ resolved. Read APIs: `GET /errors/v1/issues`
  (`?project=&status=`) is API-key-authed; `GET /api/errors/issues/:id` and
  `PATCH /api/errors/issues/:id {status}` are dashboard-only.
  (`errors/routes/issues.ts`, `dashboard-web/src/products/errors/pages/*`.)
- **No project-creation and no key UI in ZeroErrors:** an errors "project" is
  created implicitly by the first ingest carrying that `project` name; the
  console only lists/filters. (`IssuesPage.tsx`; no create/delete project
  route exists for errors.)

### Best reporter example (extract, don't invent)

Both live reporters are the canonical minimal Worker reporter. A correct,
minimal, generic snippet distilled from them (fire-and-forget, never throws):

```ts
const ENDPOINT = "https://api.zeroapps.dev/errors/v1/errors";

export async function reportError(
  apiKey: string,
  project: string,
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ project, message, stack, context }),
    });
  } catch {
    // Reporting must never disturb the caller. Swallow transport failures.
  }
}
```

Hono `onError` wiring (from both apps' `app.ts` / `dashboard-app.ts`):
`app.onError((err, c) => { c.executionCtx.waitUntil(reportError(c.env.ZEROVAULT_API_KEY, "my-app", err, { path: c.req.path })); return c.json({ error: "Internal error" }, 500); })`.

---

## Blockers / gaps found (must shape the content; some may need a product fix)

These are real friction points in the products today. The docs must either work
around them honestly or they need a product change first. Flagged for the
approver.

1. **BLOCKER — new user has no organization; every `/api/*` call 403s.**
   The `/api/*` middleware requires an active Clerk org and returns
   `403 {error:"No active organization"}` when absent
   (`dashboard-app.ts`). A brand-new signup lands on `/vault/projects` with **no
   org** and no forced org-creation step; the only way to create one is the
   Clerk `OrganizationSwitcher` in the top-right corner (`AppLayout.tsx`). API
   keys are org-scoped, so nothing works until an org exists.
   - **Docs workaround:** the ZeroVault getting-started MUST have an explicit
     "Step 1: create your organization" using the org switcher, before create-a-
     project. Verify the exact first-run wording/behavior in production (does the
     projects list show an error, a blank, or a prompt with no org?) and document
     what the user actually sees.
   - **Recommend to approver:** consider a product fix (force org selection /
     auto-create a personal org on signup) so the first run is not a dead end.
     Not required to ship docs, but the docs will otherwise describe a rough
     edge.

2. **ZeroErrors ingest requires a ZeroVault key (cross-product).** There is no
   errors-only key UI. The errors getting-started must send the user to
   ZeroVault → API Keys first. Document this explicitly; it is not obvious.

3. **ZeroErrors has no delete for issues or projects.** Issues can be
   resolved but not deleted, and there is no "delete project" for errors. So a
   scratch errors project/issue created during verification **cannot be cleaned
   up** — it persists in the demo org. Plan verification to use a clearly named
   demo project (e.g. `docs-demo`) and accept it lingers, or run errors
   verification in a throwaway org. (Vault projects CAN be deleted, so vault
   scratch data cleans up fully.)

4. **CLI `--version` prints `0.2.1` but npm latest is `0.2.2`.** `src/index.ts`
   hardcodes `.version("0.2.1")` while the published package is `0.2.2`. Cosmetic
   mismatch; docs should pin `zerovault-cli@0.2.2` (matching AGENTS.md) and not
   promise that `zv --version` prints `0.2.2`. Optional product fix: bump the
   hardcoded version string.

5. **`zv secrets set` uses PATCH (upsert), `zv` has no per-secret create vs
   update distinction.** Fine, but document `set` as create-or-update and
   `delete`/`set KEY=` semantics accurately (delete sends `value:null`).

None of 2-5 block shipping docs; they shape wording. Item 1 is the one worth a
product decision before or alongside publishing.

---

## Page inventory

Under `apps/docs/src/content/docs/`. Six new, two rewritten (the two `overview`
placeholders). `skills/overview.md` stays a placeholder seam (out of scope) but
must keep a **page-level** `noindex` once the global one is removed (see step on
noindex).

| File | Type | Purpose |
|---|---|---|
| `index.mdx` | rewrite | Orient across both products; route to each getting-started. |
| `vault/overview.md` | rewrite | Short "what is ZeroVault" + object model (project → env → secret, org-scoped keys). Links to getting-started. |
| `vault/getting-started.mdx` | new | UI path: sign in → create org → create project → add a secret → create an API key. |
| `vault/cli.mdx` | new | Install `zv`, auth precedence + contexts, command reference, `secrets download`. |
| `vault/workers.mdx` | new | Pull secrets into a Cloudflare Worker deploy; `secrets.required` gate. |
| `errors/overview.md` | rewrite | "What is ZeroErrors" + grouping model + issue lifecycle. |
| `errors/getting-started.mdx` | new | Get a key (from Vault) → POST first error via `curl` → see the issue → resolve it. |
| `errors/worker-integration.mdx` | new | Drop-in `onError` reporter for a Worker (distilled from the two live reporters). |

**Sidebar** (`apps/docs/astro.config.mjs`), replacing the current one-item-each
placeholder sidebar:

```js
sidebar: [
  { label: "ZeroVault", items: [
    { label: "Overview", slug: "vault/overview" },
    { label: "Getting started", slug: "vault/getting-started" },
    { label: "CLI", slug: "vault/cli" },
    { label: "Cloudflare Workers", slug: "vault/workers" },
  ]},
  { label: "ZeroErrors", items: [
    { label: "Overview", slug: "errors/overview" },
    { label: "Getting started", slug: "errors/getting-started" },
    { label: "Worker integration", slug: "errors/worker-integration" },
  ]},
  { label: "Skills", items: [{ label: "Overview", slug: "skills/overview" }] },
],
```

---

## Per-page outlines (with the concrete commands/snippets each shows)

Write for users, no internal module names (per AGENTS.md). Every command shown
must be one the implementer actually ran (checklist below).

### `index.mdx`
- One paragraph each: ZeroVault (secrets for your apps/Workers) and ZeroErrors
  (error tracking for your apps).
- "One account, one key": sign in at `dash.zeroapps.dev`; a single `zv_` API key
  works for both products.
- Two clear links: "Start with ZeroVault" → `vault/getting-started`, "Start with
  ZeroErrors" → `errors/getting-started`.

### `vault/overview.md`
- What ZeroVault is; the object model: **Organization → Project → Environment
  (`development`, `production` by default) → Secret**. API keys are org-scoped.
- Where things live: dashboard `dash.zeroapps.dev/vault`, API
  `api.zeroapps.dev/vault/v1`, CLI `zv`.
- Link onward to getting-started / CLI / workers.

### `vault/getting-started.mdx` (UI)
1. Go to `https://dash.zeroapps.dev`, sign up / sign in.
2. **Create your organization** via the org switcher (top-right). (Exact wording
   pending production check — BLOCKER 1.)
3. Create a project on the Projects page; note it auto-creates `development` and
   `production`.
4. Open the project → an environment → add a secret (key/value), save.
5. Create an API key on the **API Keys** page; copy it now (shown once).
6. "Next: use it from the CLI / in a Worker" links.

### `vault/cli.mdx`
- Install/run: `pnpm dlx zerovault-cli@0.2.2 --help` (bin `zv`). Note npm latest
  is `0.2.2`.
- Auth: `export ZEROVAULT_API_KEY=zv_...` then `zv whoami`. Mention precedence
  and `ZEROVAULT_API_URL` default `https://api.zeroapps.dev/vault`.
- Contexts (optional, for multiple orgs / dirs):
  `zv context add work --api-key zv_...` / `zv context use work`.
- Core flow:
  ```bash
  zv projects create demo
  zv secrets set API_TOKEN=abc123 -p demo -e development
  zv secrets list -p demo -e development
  zv secrets get API_TOKEN -p demo -e development
  zv secrets download -p demo -e development -f env
  ```
- Note `set` is create-or-update; `zv secrets delete KEY` removes it.
- Mention `zv export`/`import` briefly with the plaintext warning.

### `vault/workers.mdx`
- Goal: get ZeroVault secrets into a Cloudflare Worker at deploy time.
- Pattern (generic, not this repo's bin scripts):
  ```bash
  zv secrets download -p demo -e production -f json -o secrets.json
  npx wrangler secret bulk secrets.json
  rm secrets.json
  ```
- Deploy gate: add required secret names to `secrets.required` in
  `wrangler.jsonc` so a deploy fails loudly if a secret is missing. Show a small
  `wrangler.jsonc` snippet with `"secrets": { "required": ["API_TOKEN"] }` and
  the caveat that the field is not in the schema / `--dry-run` but is enforced at
  real deploy.

### `errors/overview.md`
- What ZeroErrors is: send an error report, it groups into an **issue**.
- Grouping: same project + normalized message + first stack frame → one issue;
  ids/hashes/numbers in the message are masked so repeats collapse. `count`,
  `firstSeenAt`, `lastSeenAt`, `level` (`error`/`warning`/`info`, default
  `error`), `status` (`open`/`resolved`).
- Console: filter by project, toggle resolved, open an issue to see its events.
- Keys come from ZeroVault (cross-product note).

### `errors/getting-started.mdx`
1. Get an API key: ZeroVault → **API Keys** → Create (link to
   `vault/getting-started`). One key covers both products.
2. Send your first error:
   ```bash
   curl -sS -X POST https://api.zeroapps.dev/errors/v1/errors \
     -H "authorization: Bearer $ZEROVAULT_API_KEY" \
     -H "content-type: application/json" \
     -d '{"project":"docs-demo","message":"Hello from getting-started","level":"info"}'
   ```
   Response: `202 {"issueId":"...","isNew":true}`.
3. Open `https://dash.zeroapps.dev/errors`, filter by `docs-demo`, see the
   issue; open it to see the event; click Resolve.
4. Note the payload fields (`project`, `message`, `stack?`, `level?`,
   `context?`) and limits.

### `errors/worker-integration.mdx`
- The distilled `reportError` + Hono `onError` snippet from the "Best reporter
  example" section above.
- Store the key as a Worker secret (`ZEROVAULT_API_KEY`), gate it with
  `secrets.required` (link to `vault/workers`).
- Note fire-and-forget via `executionCtx.waitUntil`, never throws, so it can't
  break the request path.

---

## Production-verification checklist (do before publishing)

The implementer must run all of these against production and paste evidence into
the change. Use a scratch org if possible; otherwise the demo org with named
scratch resources. **Every command that appears in the docs must have been
executed successfully by the implementer** — no un-run commands ship.

ZeroVault (fully cleanable):
- [ ] Sign in at `dash.zeroapps.dev`; record exactly what a **no-org** account
      sees on first load (confirms/should-fix BLOCKER 1). If a fresh account
      isn't available, at least verify the org-switcher create flow and the 403
      behavior by testing an org-less session.
- [ ] Create org (or use existing), create project `docs-demo` in the UI;
      confirm `development` + `production` auto-appear.
- [ ] Add a secret in the UI; confirm it reads back.
- [ ] Create an API key in the UI; confirm the copy-once reveal; set
      `ZEROVAULT_API_KEY`.
- [ ] `pnpm dlx zerovault-cli@0.2.2 whoami` returns the org/user.
- [ ] Run every CLI command shown in `vault/cli.mdx` against `docs-demo`
      (`projects create/list`, `secrets set/list/get/download`).
- [ ] `zv secrets download -f json` output shape matches what `wrangler secret
      bulk` expects (spot-check format only; no need to deploy a throwaway
      Worker unless quick).
- [ ] `zv projects delete docs-demo` — confirm full cleanup (list no longer
      shows it).

ZeroErrors (issue persists — accept or use throwaway org):
- [ ] POST the exact `curl` from `errors/getting-started.mdx`; confirm `202` and
      an `issueId`.
- [ ] POST it twice more; confirm the console shows ONE issue with `count` > 1
      (grouping works).
- [ ] Confirm the issue is visible at `dash.zeroapps.dev/errors` filtered by
      `docs-demo`, open it, and Resolve it (leaves it resolved, not deleted —
      known gap 3).
- [ ] Confirm a bad payload returns `400` and a missing/oz key returns `401`
      (quick negative checks so the docs' error notes are true).

Site (after content is in and built):
- [ ] `pnpm --filter @zero/docs run build` + `typecheck` + `lint` all pass; new
      `.md` twins exist in `dist` for each new page.
- [ ] After deploy: each new page 200s over HTTPS; its `<page>.md` twin fetches
      as `text/markdown`; `llms-full.txt` includes the new content.

---

## noindex removal + sitemap submission (scaffold deferred this on purpose)

The scaffold set a **site-wide** `noindex, nofollow` via Starlight `head` and
deliberately did not submit the sitemap. This change flips that once real
content is live:

1. **Remove the global `noindex`** `head` entry from
   `apps/docs/astro.config.mjs` (the whole `head: [...]` robots meta).
2. **Keep `skills/overview` non-indexable** since it stays placeholder: add a
   page-level `head` robots `noindex, nofollow` in that page's frontmatter so the
   thin skills page is not indexed while the real product pages are. (Starlight
   supports per-page `head` in frontmatter.)
3. Verify in production: `curl -s https://docs.zeroapps.dev/vault/getting-started/`
   has NO `noindex`; `curl -s https://docs.zeroapps.dev/skills/overview/` still
   has `noindex`.
4. **Submit the sitemap** `https://docs.zeroapps.dev/sitemap-index.xml` in Google
   Search Console under the existing `sc-domain:zeroapps.dev` Domain property
   (covers the `docs.` subdomain already; no new property needed — per the
   scaffold verify report). This is a console action, done by a human; call it
   out as the one non-code step. `robots.txt` already `Allow: /` with the
   sitemap line, so no robots change is needed.

---

## Changelog (scaffold deferred it to this change)

Per AGENTS.md routing, docs for the console products go in the **root
`CHANGELOG.md`** (not `apps/agent-api/CHANGELOG.md`). Load the `changelog` skill
before editing. Add, most recent first, dated to the implementation day, e.g.:

```
- YYYY-MM-DD: ZeroVault and ZeroErrors docs now include getting-started guides at docs.zeroapps.dev, covering signing in, storing secrets, the zv CLI, pulling secrets into a Cloudflare Worker, and sending your first error.
```

User-facing wording only; commit it with the content.

---

## Skills to use during implementation

- `changelog` — before editing root `CHANGELOG.md`.
- `reproducible-locally` — drive the production-verification checklist; note the
  NixOS box can't run `wrangler dev`/`workerd`, so site checks are `astro build`
  + `astro check` locally and `curl` against production after deploy.
- `impeccable` — only if tuning page layout/nav; content is the priority.
- `git-commit` — when committing.
- `ai-writing-signs` — keep the prose clean and human when writing pages.

---

## Acceptance criteria (objectively checkable)

1. Eight pages exist and are live: `curl -sI` returns `200` over HTTPS for
   `/`, `/vault/overview/`, `/vault/getting-started/`, `/vault/cli/`,
   `/vault/workers/`, `/errors/overview/`, `/errors/getting-started/`,
   `/errors/worker-integration/`.
2. Each page's `.md` twin fetches with `content-type: text/markdown`
   (e.g. `/vault/getting-started.md`, `/errors/worker-integration.md`).
3. The verification checklist is complete and its evidence is attached: **every
   command shown in the docs was executed successfully** against production
   (CLI commands, the `curl` ingest returning `202`+`issueId`, the issue visible
   and grouped in the console).
4. The ingest endpoint documented is `https://api.zeroapps.dev/errors/v1/errors`
   (not the stale `errors.apps.juanibiapina.dev/...`).
5. Global `noindex` removed: product pages have no `noindex` meta;
   `skills/overview` retains a page-level `noindex`.
6. Sitemap submitted to Search Console under `sc-domain:zeroapps.dev` (human
   step recorded as done).
7. A user-facing entry is present in root `CHANGELOG.md`, committed with the
   content.
8. `pnpm --filter @zero/docs run build`, `typecheck`, and `lint` pass; landing
   and all other apps are untouched in the diff.
```