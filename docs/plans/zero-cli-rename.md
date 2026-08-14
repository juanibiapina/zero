# Plan: replace `zv` with `zero`, scope vault commands, add errors commands

## Goal

One CLI for the whole Zero suite. A user installs `zero`, runs `zero vault ...`
for secrets and `zero errors ...` for issues, with one org-scoped key that both
products already accept. `zv` is gone: no alias binary, no old command spellings,
no config or env-var migration. Docs and the public skills repo describe only the
new shape.

**Breaking change, on purpose.** Anyone on `zv` reinstalls, renames their env
var, and re-runs `zero context add`. This is acceptable because the product is
young; do not reintroduce compatibility shims during implementation.

## Background (verified in this checkout, `main` up to date with origin)

**The CLI today.** `packages/zerovault-cli`, npm name `zerovault-cli` (v0.2.3),
single bin `zv`. `src/index.ts` (499 lines) wires every command inline with
commander: `whoami`, `context {list,current,use,unset,add,remove}`, `projects`,
`env`, `secrets {list,get,set,delete,download}`, `export`, `import`,
`keys {create,list,revoke}`. `src/client.ts` is one `ZeroVaultClient` holding
`baseUrl` + `apiKey` and a private `request()`; every method appends `/v1/...`.
`src/config.ts` owns `~/.config/zerovault/config.json` (0600 in a 0700 dir,
override `ZEROVAULT_CONFIG`), named contexts, per-directory bindings, and
`resolveAuth` precedence: `--api-key` flag > directory context > `ZEROVAULT_API_KEY`
env. `DEFAULT_BASE_URL = "https://api.zeroapps.dev/vault"`.

**The API is already unified.** `packages/auth`'s `validateApiKey` is the shared
front door; `apps/vault-api/src/dashboard-app.ts` runs it for both `/vault/v1/*`
and `/errors/v1/*`, with separate rate limiters per prefix. One `zv_…` key
authorizes both products. (The key *prefix* stays `zv_`: it is stored data, not a
CLI name. Renaming it would invalidate every issued key.)

**Errors endpoints on the API-key surface (`/errors/v1`)**, from
`apps/vault-api/src/errors/routes/`:

| Method | Path | Notes |
|---|---|---|
| GET | `/errors/v1/whoami` | same shape as vault whoami |
| POST | `/errors/v1/errors` | ingest; `{project, message, stack?, level?, context?}` → `202 {issueId, isNew}` |
| GET | `/errors/v1/issues?project=&status=` | `status` is `open`\|`resolved` |
| PATCH | `/errors/v1/issues/:id` | `{"status":"open"\|"resolved"}` → `200 {issue}` |
| DELETE | `/errors/v1/issues/:id` | `204`, `404 {"error":"Issue not found"}` |

Issue **detail** (`GET /api/errors/issues/:id`) is dashboard-only (Clerk
session). There is no `/errors/v1/issues/:id` GET.

**npm naming is constrained.** `zero` (v1.1.23) and `zero-cli` (v0.0.12) are both
taken on npm by other packages. The `@zeroapps` scope is free: `-/org/zeroapps/package`
→ `{"error":"Scope not found"}`, `-/v1/search?text=scope:zeroapps` → 0 results,
`@zeroapps%2fcli` → 404. A scope is either an org or a username, and the username
would have to be yours (`scope:juanibiapina` also has 0 packages), so **`@zeroapps`
means creating an npm organization** named `zeroapps` (free tier covers public
packages). Unscoped `zeroapps-cli`, `zerocli`, `zero-apps-cli` are also free.

**Trusted publishing cannot cover a first publish.** `npm trust` prerequisites:
"**Package must exist**: The package you're configuring must already exist on the
npm registry." The npm docs gap is tracked in `npm/documentation#1926`, whose
reporter hit exactly this and had to publish manually once before OIDC worked.
Related constraints from the same docs: account-level 2FA is required for trust
commands (GATs with "bypass 2FA" are rejected); `repository.url` in `package.json`
must match the GitHub repo exactly; and **npm does not validate a trusted-publisher
config when saved**, so a wrong field only surfaces at publish time, masked as
`ENEEDAUTH` / `E404`.

**Release machinery.** `.github/workflows/publish-cli.yml` publishes on a `v*`
tag via npm trusted publishing (OIDC). npm binds that trust to the **workflow
filename** and to the **package name**. `docs/cli-releases.md` documents the
steps and failure modes (tag must equal version; `E404` really means
trusted-publisher misconfig).

**In-repo consumers** (all pin `pnpm dlx zerovault-cli@0.2.2`):
`bin/fetch-secrets`, `bin/sync-secrets-to-cloudflare`, `bin/e2e-test`,
`bin/set-telegram-webhook`, plus a comment in `bin/json-to-dotenv.mjs`. These are
ours and get updated in the same change.

**Doc surfaces:** `apps/docs/src/content/docs/vault/cli.mdx` (23 `zv`
occurrences), `vault/loading-secrets.mdx`, `vault/getting-started.mdx`,
`vault/workers.mdx`, `account/api-keys.md`, `errors/*`, plus repo `AGENTS.md`
(3 places), `docs/secrets.md`, `docs/cli-releases.md`, `docs/e2e-tests.md`.

**Public skills repo** `juanibiapina/zero-skills` (cloned at
`~/workspace/juanibiapina/zero-skills`, source of truth, installable via
`npx skills add`) has `zerovault/SKILL.md` (17 `zv` lines) and
`zeroerrors/SKILL.md` (curl-only today). Per root `AGENTS.md`, any change to a
documented CLI command or user flow must land there **in the same change**.

## Decisions

1. **npm package `@zeroapps/cli`, single bin `zero`.** `zero`/`zero-cli` are
   taken. The scope also leaves room for `@zeroapps/reporter` later.
   `publishConfig.access: "public"` is already set and is required for a scope.
2. **No `zv` anywhere.** No alias bin, no hidden command aliases, no deprecation
   notice logic. The old package gets one `npm deprecate zerovault-cli "renamed
   to @zeroapps/cli"` tombstone and no further releases.
3. **Command tree.** Product-scoped where the product owns the object; flat where
   the object is org-level:
   ```
   zero whoami
   zero context {list,current,use,unset,add,remove}
   zero keys {create,list,revoke}          # org-scoped, authorizes both products
   zero vault {projects,env,secrets,export,import}
   zero errors {report, issues {list,get,resolve,reopen,delete}}
   ```
   `keys` stays top-level on purpose: it mirrors the console IA decided in
   `docs/plans/unified-api-keys.md`, where keys moved out of Vault into Account
   precisely because a key is not a Vault object. Nesting them under
   `zero vault keys` would re-tell the lie that plan removed.
4. **Base URL is product-neutral.** `DEFAULT_BASE_URL = "https://api.zeroapps.dev"`;
   the vault client prefixes `/vault/v1`, the errors client `/errors/v1`, and the
   **keys client also prefixes `/vault/v1`** — `/vault/v1/keys` is the only
   API-key route for keys (`apps/vault-api/src/routes/keys.ts:43-45`); there is no
   `/keys/v1`. `zero keys` being top-level is information architecture, not a new
   endpoint, and this plan authorizes exactly one server route (decision 7). No
   `/vault`-stripping compatibility rule. Every in-repo script that sets a base
   URL (notably `bin/e2e-test`, which targets a local worker) drops the `/vault`
   suffix in this change.
5. **Env vars are `ZERO_API_KEY` / `ZERO_API_URL` / `ZERO_CONFIG` only.** The
   `ZEROVAULT_*` names are not read. `bin/*` scripts, `docs/secrets.md`, and
   `AGENTS.md` are updated together, and the local shell/`.envrc` that exports
   `ZEROVAULT_API_KEY` must be updated by hand after this lands.
6. **Config lives at `~/.config/zero/config.json`.** No copy or read-fallback
   from `~/.config/zerovault/`. A user with the old file re-runs
   `zero context add`. The old file is left on disk untouched.
7. **Add `GET /errors/v1/issues/:id`** to `apps/vault-api` so `zero errors issues
   get <id>` exists. Two lines next to the existing `/api` route in
   `createIssuesRouter`; makes the API-key surface symmetric so the CLI's read
   path does not force the browser. Only server change in this plan.
8. **Do not rename `.github/workflows/publish-cli.yml`.** npm's trusted-publisher
   entry is bound to that filename.

## Technical approach

**Package.** `git mv packages/zerovault-cli packages/zero-cli`; `name:
"@zeroapps/cli"`, `version: 0.3.0`, `bin: { zero: "./dist/index.js" }`, and
`repository.directory: "packages/zero-cli"` (npm checks `repository.url` against
the publishing repo; a stale `directory` is sloppy and the URL match is
mandatory). Nothing
in the monorepo imports it; the workspace name appears only in the publish
workflow and `docs/cli-releases.md`.

**Structure.** `index.ts` at 499 lines already mixes wiring, output, and auth
resolution; adding a whole product doubles it. Split:

```
src/
  index.ts            # program setup, global options, parse
  auth.ts             # getVaultClient()/getErrorsClient(): flag+context+env precedence, one place
  config.ts           # same responsibilities, new path and env var
  clients/http.ts     # request(): baseUrl, bearer, ApiError, 204 handling
  clients/vault.ts    # VaultClient  (paths under /vault/v1)
  clients/errors.ts   # ErrorsClient (paths under /errors/v1)
  commands/context.ts
  commands/keys.ts
  commands/vault.ts
  commands/errors.ts
```
Each `commands/*.ts` exports `register(program)`. The split follows the product
boundary, not file size: `clients/http.ts` is the single place that knows bearer
auth and error mapping, each client is a thin typed façade over it. Keep
`ApiError` exported so existing tests keep their import path shape.

**Response types stay inline.** The published package has exactly one runtime
dependency (`commander`); the two `@zero/*` entries in `package.json` are
devDependencies. `client.ts` declares every response shape inline for that
reason. Do **not** import `@zero/errors-core` or `@zero/vault-core` in
`clients/*` — they are unpublished workspace packages and would break the
tarball. Copy the shapes that matter:

- ingest limits, from `errorReportSchema` (`packages/errors-core/src/index.ts:39`):
  `project` 1-200 chars, `message` 1-10000, `stack` ≤50000, `level` is
  `error|warning|info`, `context` is a JSON object. Let the server reject and
  surface its `400`; do not duplicate validation logic beyond obvious flag
  parsing.
- `IssueSummary`: `id, fingerprint, project, title, level, status, count,
  firstSeenAt, lastSeenAt`. Human output prints `id, status, level, count,
  lastSeenAt, title`; `--json` prints the response verbatim.

**`zero whoami` calls `/vault/v1/whoami`.** `/errors/v1/whoami` exists and returns
the identical `{userId, orgId}` (`dashboard-app.ts:79-80`); pick one and stay
there.

**Flag spellings do not change.** Only command paths move. `zero vault secrets
download -p … -e … --format json` must keep working the way `zv secrets download`
does today, because `bin/e2e-test` pipes it into `bin/json-to-dotenv.mjs`.

**Errors commands → API:**

| Command | Call |
|---|---|
| `zero errors report -p <project> -m <msg> [--level] [--stack -] [--context <json>]` | POST `/errors/v1/errors`; print `issueId` and whether it grouped |
| `zero errors issues list [-p <project>] [-s open\|resolved]` | GET `/errors/v1/issues` |
| `zero errors issues get <id>` | GET `/errors/v1/issues/:id` (new route) |
| `zero errors issues resolve <id>` / `reopen <id>` | PATCH `{status}` |
| `zero errors issues delete <id>` | DELETE; `404` → clear message, exit 1 |

Flags copy the vault side (`-p` for project) so both halves feel like one tool.
`--json` on list/get for scripting: data on stdout, everything else on stderr.

## System-wide impact

- `bin/fetch-secrets`, `bin/sync-secrets-to-cloudflare`, `bin/e2e-test`,
  `bin/set-telegram-webhook` switch to `pnpm dlx @zeroapps/cli@0.3.0`, the
  `zero vault ...` subcommands, `ZERO_API_KEY`/`ZERO_API_URL`, and base URLs
  without the `/vault` suffix. These break the moment the plan lands and are
  fixed in the same change; the developer's exported `ZEROVAULT_API_KEY` is the
  one thing outside the repo that needs a manual rename.
- `bin/json-to-dotenv.mjs` consumes piped stdout, so the CLI must keep stdout
  clean of anything but data.
- `apps/vault-api` gains one route; no schema, DO, or auth change. `zv_` key
  prefix untouched.
- `zero-skills` promises `zv` in 17 places; both skills change.
- **The rename redeploys all four Workers.** `pnpm-lock.yaml:672` names
  `packages/zerovault-cli`, and `pnpm-lock.yaml` is in the build watch paths of
  `zero-api`, `zerovault-api`, `zero-landing` and `zero-docs` (root `AGENTS.md`).
  Merging therefore resets `UserDO` instances mid-turn. Unavoidable for a
  directory rename; land it as one push, at a quiet hour, and do not chain it
  with other deploys.

## Implementation phases

Each phase is a separate commit; 1-4 land in one PR, 5 and 6 gate on the npm
publish.

1. **Server:** `GET /errors/v1/issues/:id` + route test (RED first).
2. **CLI internals:** package/dir rename, file split, `clients/http.ts` +
   `VaultClient`, new config path and env var names, product-neutral base URL.
   Existing tests carry over with renamed identifiers.
3. **New surface:** `zero vault …` scoping and `zero errors …` commands.
4. **Repo consumers + docs.** Every live reference to the old package or command,
   verified by `rg -n "zerovault-cli|\bzv\b"`. Files under `docs/plans/` are
   historical records and stay as written; everything else changes:
   - `bin/fetch-secrets`, `bin/sync-secrets-to-cloudflare`, `bin/e2e-test`,
     `bin/set-telegram-webhook` (each pins `zerovault-cli@0.2.2`, itself already
     stale against npm latest `0.2.3`), and the comment in `bin/json-to-dotenv.mjs`
   - `AGENTS.md` lines ~167, ~190, ~299
   - `docs/secrets.md`, `docs/cli-releases.md`, `docs/e2e-tests.md`
   - `.github/workflows/publish-cli.yml` job name and header comment (text only,
     **filename unchanged**)
   - root `CHANGELOG.md` entry stating the break
5. **Publish.** The first release cannot go through the tag workflow, because npm
   requires the package to exist before a trusted publisher can be configured:
   1. Create the npm org `zeroapps` (claim it early; unclaimed today is not
      unclaimed tomorrow).
   2. From a logged-in machine with account 2FA on: `cd packages/zero-cli && npm
      publish` for `0.3.0`. One time only. Check `package.json` `repository.url`
      matches `juanibiapina/zero` and `repository.directory` is the **new** folder
      first, or the publish is rejected.
   3. npmjs.com → `@zeroapps/cli` → Settings → Trusted Publishers: repository
      `juanibiapina/zero`, workflow filename `publish-cli.yml` (unchanged),
      allowed action `npm publish`. npm does not validate this on save.
   4. Prove it with the next release (`0.3.1`) going through the tag workflow.
      Until a workflow publish succeeds, assume the config is wrong.
   5. `npm deprecate zerovault-cli "renamed to @zeroapps/cli"`.
6. **Public docs + skills:** `apps/docs` CLI reference covering both products,
   pinned version updated, and `juanibiapina/zero-skills`
   `zerovault/SKILL.md` + `zeroerrors/SKILL.md` rewritten to `zero vault …` /
   `zero errors …`. The errors skill teaches raw `curl` today; replace the issue
   list/delete/resolve recipes with CLI commands and keep the ingest `curl`
   (reporting comes from arbitrary runtimes). Drop the stale
   `zv --version misreports 0.2.1` gotcha.

## Test strategy

- `config.test.ts`: `~/.config/zero/config.json` is the path, `ZERO_CONFIG`
  overrides it, an old `~/.config/zerovault/config.json` is **not** read.
- `auth.test.ts` (absorbs `no-key-error.test.ts`): precedence over
  flag/context/`ZERO_API_KEY`; `ZEROVAULT_API_KEY` alone yields the no-key error;
  that error names `zero` and the docs URL.
- base URL: default has no `/vault`; a user-supplied `…/vault` is passed through
  verbatim (no magic), which the tests pin so nobody re-adds stripping later.
- `clients/errors.test.ts`: each verb hits the right path/method/body; delete
  `404` surfaces `ApiError` with status; ingest `202` returns `isNew`.
- command-wiring smoke tests: `zero vault secrets list` reaches the expected
  client call; stdout carries only data.
- server: `GET /errors/v1/issues/:id` returns issue + events for the caller's
  org, `404` unknown, `401` without a key.

## Documentation strategy

- Root `CHANGELOG.md` (console/vault product, **not** `apps/agent-api/CHANGELOG.md`):
  one entry naming the new CLI, the errors commands, and the break.
- `docs/cli-releases.md`: new npm name and package directory, unchanged workflow
  filename, and a new "first publish" note recording why `0.3.0` was published by
  hand (npm requires the package to exist before a trusted publisher can be
  attached) so nobody rediscovers it at the next rename.
- `apps/docs`: shared install/auth page, command reference per product, every
  `zv` sample replaced.
- `zero-skills`: both SKILL.md files, same change, per the repo rule.

## Skills to use

- `tdd` — the server route and every new CLI behavior.
- `cli-design` — command tree, stdout/stderr split, `--json`, exit codes.
- `codebase-design` — the `clients/` + `commands/` split; keep `http.ts` deep.
- `technical-writing` — docs and skills rewrite.
- `changelog` — before touching `CHANGELOG.md`.
- `git-commit`, `open-pr` — committing and shipping.

## Acceptance criteria

- `npx @zeroapps/cli@latest --help` lists `whoami`, `context`, `keys`, `vault`,
  `errors`, and no `zv` binary is installed.
- `zero vault secrets list -p demo -e production` and `zero errors issues list`
  both work with the same `zv_…` key.
- `zero vault secrets download … --format json | bin/json-to-dotenv.mjs` produces
  a valid `.env`.
- With only `ZEROVAULT_API_KEY` exported, `zero whoami` fails with the no-key
  error that names `ZERO_API_KEY`.
- `bin/fetch-secrets` works after exporting `ZERO_API_KEY`.
- `npm view zerovault-cli` shows the package deprecated, pointing at the new name.
- No file in this repo or in `zero-skills` mentions `zv` as a command, except the
  historical records under `docs/plans/` (the `zv_` key prefix also stays).
- `zero keys list` succeeds, proving the keys client kept the `/vault/v1` prefix.
- `npm pack` on the built package contains no `@zero/*` runtime import.

## Risks and open questions

- **First publish is manual.** Confirmed, not a maybe: npm requires the package to
  exist before a trusted publisher can be attached, so `0.3.0` ships from a
  laptop. That machine needs an npm login with 2FA; this dev box has none
  (`npm whoami` → `need auth`), which is by design since CI publishes.
- **Scope ownership.** `@zeroapps` is unclaimed today and must be created as an
  npm org. Claim it before announcing anything.
- **Package name alternative.** Unscoped `zeroapps-cli` is free and avoids org
  creation and the scope/access flag. The manual-first-publish constraint is
  identical either way, so the scope is worth it only if sibling packages
  (`@zeroapps/reporter`) are actually coming.
- **Timing.** Between phase 4 landing and phase 5 publishing, `bin/*` reference a
  package version that does not exist yet on npm, so secret fetching is broken on
  `main`. Since phase 5 is a manual `npm publish` rather than a tag push, do it
  from the branch right before merging, or immediately after, and keep the window
  to minutes.
- **Open question:** does `zero errors report` earn its place, given ingest is a
  `curl` from arbitrary runtimes? Useful for smoke tests and CI hooks, but it is
  the one command whose main audience is not a human at a terminal.
- **Open question:** one CLI docs page or one per product? Install and auth are
  shared; the command halves are not.
