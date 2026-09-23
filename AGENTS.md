# Instructions for AI Agents

## Development

During development, use `gob run bin/ci` to run all necessary checks including build, linter, tests etc.

**Mobile (`apps/agent-mobile`):** unit tests, lint, and typecheck run in the Turbo pipeline like the other packages. On the `mini` host (2 CPUs, 7.6 GB RAM) these checks are cheap in isolation but crawl 10-50x when they compete for memory: stop Metro and any local `gradlew`/`eas build --local` before running them, prefer EAS cloud builds, and use `jest --runInBand` / `turbo --concurrency=1`. See the "Run checks on a starved box" section of `apps/agent-mobile/README.md`. Use `pnpm --filter @zero/agent-mobile e2e:pixel` as the default behavioral device proof. Add or update a behavior-named flow under `.maestro/hermetic/` when a change affects native rendering, persisted collections, gestures, routing, or screen composition. Reserve manual inspection for visual, auditory, tactile, accessibility-judgment, or otherwise non-assertable criteria. The manual emulator workflows remain optional and upload screenshot, logcat, and UI-hierarchy artifacts. See `apps/agent-mobile/README.md`.

**Every mobile (`apps/agent-mobile`) change must be verified on the real Pixel 7 before it is considered done** — unit tests and typecheck are necessary but not sufficient. A real **Pixel 7** is USB-attached to `mini`; `e2e:pixel` loads the current JavaScript from dedicated headless Metro into its installed development client, uses fake auth and a local Worker, and isolates every app-owned store from production. The command never installs an APK. This device remains dev-client-only: never install a preview, production, or E2E standalone build. Build and install a fresh `development-pixel` client only when the native fingerprint changes, then run the hermetic command. For manual visual inspection with normal Metro, the API defaults to production; never mutate existing user entities, and create then delete only throwaway entities if a write is unavoidable. Maestro's `tapOn` can report success yet miss a short-lived overlay like a 4s toast; use a flow with no gap or tap the live hierarchy bounds. See the "Physical device testing" section in `apps/agent-mobile/README.md`.

**Local `workerd` limitation:** on dev boxes where the host `workerd` binary can't start (e.g. NixOS), direct `wrangler dev` / `dev:worker` cannot start for any Worker, including asset-only ones like `apps/landing` (observed: `write EPIPE` then "NixOS cannot run dynamically linked executables"). The `e2e:pixel` harness is the supported exception: it runs the Task Worker inside rootless Podman. `gob run bin/ci` and `bin/e2e-test` still can't run whole-repo because they boot host `workerd`. For other changes, verify the touched package directly, e.g. `pnpm --filter @zero/agent-api run test`, plus `pnpm --filter @zero/agent-api run lint` and `pnpm --filter @zero/agent-api run typecheck`. GitHub Actions CI runs lint, typecheck, build, package tests, and the deploy dry-run. The `packages/agent-e2e` suite is **not** wired into CI; run it manually via `bin/e2e-test` on a `workerd`-capable machine.

## Changelog

Any change a user can observe (new capability, changed behavior, user-visible
fix) must add a bullet to a changelog **in the same change**. Include the
changelog entry in the plan and commit it together with the code, never as a
separate follow-up after deployment.

- Format: `- YYYY-MM-DD: <what the user now sees or gets>`, most recent first.
- Write from the user's perspective. No module or function names, no internal
  mechanics.
- Purely internal changes (refactors, tests, infra) get no entry.

Route the entry by product:

- **Agent (Zero assistant):** changes to `apps/agent-api` or the Telegram bot go
  in `apps/agent-api/CHANGELOG.md`.
- **ZeroVault / ZeroErrors / console:** changes to `apps/vault-*`, `apps/errors-*`,
  or shared console UI go in the root `CHANGELOG.md`.
- **Mobile todo app (`apps/agent-mobile`):** a separate product surface, NOT the
  Zero agent. Its user-facing changes do **not** go in `apps/agent-api/CHANGELOG.md`
  (that ships to agent users as the in-product Changelog topic). They go in
  `apps/agent-mobile/CHANGELOG.md`.
- **Web app (`apps/agent-web`):** user-facing changes to the web surface (e.g. the
  Inbox) go in `apps/agent-web/CHANGELOG.md`, not the agent file.

`apps/agent-api/CHANGELOG.md` is bundled and surfaced in-product as Zero's
read-only "Changelog" system topic (`apps/agent-api/src/store/system-topics.ts`),
so its entries ship to agent users on the next deploy. Keep them clean and
user-facing. The root `CHANGELOG.md` has no in-product surface today; it is the
console's human-readable changelog. **Do not mix console entries into the agent
file** — that is exactly what this split fixed.

## Agent Skills

User-facing agent skills for ZeroVault and ZeroErrors live in the public repo
[`juanibiapina/zero-skills`](https://github.com/juanibiapina/zero-skills), which
is their **source of truth** (installable via `npx skills add
juanibiapina/zero-skills`). Those skills promise live product behavior, so any
change to a documented CLI command, API endpoint, payload schema, or user flow
must update `juanibiapina/zero-skills` **in the same change**, the same shape as
the Changelog rule above. Do not fork or mirror the skills into this repo.

## Deployment

Pushing to `main` auto-deploys to production via the Cloudflare Git
connector (Workers Builds). No manual step is needed; after pushing,
wait for the Cloudflare build to finish. GitHub Actions CI only lints,
typechecks, tests, and runs a deploy dry-run; it does not deploy.
Each connector's **build watch paths** are scoped to that Worker's real
dependencies, so a push only redeploys the Workers it affects (see
[Build watch paths](#build-watch-paths-deploy-scoping) below).

Each of the four deployable Workers has its own Workers Builds git
connector on `juanibiapina/zero` (branch `main`, root dir `/`):

- `zero-api` (agent) — build `pnpm run build`, deploy `pnpm -F @zero/agent-api run deploy`
- `zerovault-api` (vault + errors dashboard) — build `pnpm run build`, deploy `pnpm -F @zero/dashboard-api run deploy`
- `zero-landing` (landing site, `zeroapps.dev`) — build `pnpm -F @zero/landing run build`, deploy `pnpm -F @zero/landing run deploy`
- `zero-docs` (docs site, `docs.zeroapps.dev`) — build `pnpm -F @zero/docs run build`, deploy `pnpm -F @zero/docs run deploy`

`zero-api` and `zerovault-api` build the whole monorepo (`pnpm run build`) and set
`VITE_CLERK_PUBLISHABLE_KEY` as a build variable, which the dashboard build needs.
`zero-landing` has no Clerk build var, so its build is scoped to the landing package
(`pnpm -F @zero/landing run build`) to avoid pulling in the dashboard build.

The `zero-landing` connector was attached 2026-07-26; before that, landing was
deployed only via manual `wrangler deploy` (it had been bootstrapped that way and
never wired into Workers Builds). See `docs/plans/workers-builds-investigation.md`.

### Per-trigger deploy commands

Each connector has up to two triggers, and they must not run the same deploy
command. The default-branch trigger deploys to production; the non-production
trigger only uploads a version for branch pushes.

| Worker | default branch (`main`) | non-production branches |
|---|---|---|
| `zero-api` | `pnpm -F @zero/agent-api run deploy` | `pnpm -F @zero/agent-api exec wrangler versions upload` |
| `zerovault-api` | `pnpm -F @zero/dashboard-api run deploy` | none (no preview trigger) |
| `zero-landing` | `pnpm -F @zero/landing run deploy` | `pnpm -F @zero/landing exec wrangler versions upload` |
| `zero-docs` | `pnpm -F @zero/docs run deploy` | `pnpm -F @zero/docs exec wrangler versions upload` |

Rules, each learned from a real breakage (2026-07-28):

- A preview trigger runs `pnpm -F <pkg> exec wrangler versions upload`, never
  `run deploy`. The `deploy` script is `wrangler deploy`, which creates a
  version **and** routes 100% of traffic to it, so a branch push would land on
  production. `versions upload` creates a version that no deployment routes.
- Always scope the command to the package with `pnpm -F <pkg>`. A bare
  `npx wrangler versions upload` runs at the repo root, where there is no
  `wrangler.jsonc`, and fails with `Missing entry-point to Worker script or to
  assets directory`. That is what broke every `zero-docs` branch build between
  2026-07-27 and 2026-07-28. `pnpm -F` also runs the repo-pinned wrangler
  instead of letting `npx` fetch the latest.
- Check the package name. `pnpm -F` exits 0 when the filter matches nothing, so
  a typo is a silent no-op that reports a green build: `zero-api`'s preview
  trigger ran `pnpm -F @zero/api run deploy` (no such package) for months and
  logged `No projects matched the filters` under a `success` outcome.
- `zerovault-api` has no preview trigger on purpose. Its build command is the
  whole-repo `pnpm run build`, which needs `VITE_CLERK_PUBLISHABLE_KEY` set as a
  build variable on each trigger, so adding one is a separate decision.

These commands live in Cloudflare, not in the repo, so a dashboard edit can
silently undo them. Read them back with
`GET /accounts/{account_id}/builds/workers/{script_tag}/triggers` after any
connector change (see `docs/plans/workers-builds-investigation.md` for the
endpoint list).

### Build watch paths (deploy scoping)

Each connector's Workers Builds **build watch paths** are scoped so a push only
rebuilds the Workers it actually affects. Before 2026-07-27 all four connectors
used the default include `*`, so any commit (CLI, docs, landing, dashboard UI)
forced a `zero-api` rebuild and reset in-flight agent turns ("Durable Object
reset because its code was updated"). The include lists now name only each
Worker's real dependency set; the exclude list is empty for all four.

Cloudflare evaluates excludes first, then includes: a build fires if any changed
path matches an include, otherwise it is skipped. A wildcard `*` matches zero or
more characters (including `/`) and may sit only at the start or end of a rule;
static entries like `turbo.json` are exact repo-root paths. A push with 0 changed
files, 3000+ changed files, or 20+ commits bypasses matching and always builds.
(Source: Cloudflare docs, "Build watch paths".)

Per-Worker **include** paths (exclude list is empty for every Worker):

- **zero-api:** `apps/agent-api/*`, `apps/agent-web/*`
- **zerovault-api:** `apps/vault-api/*`, `apps/dashboard-web/*`, `packages/auth/*`, `packages/vault-core/*`, `packages/errors-core/*`, `packages/ui/*`
- **zero-landing:** `apps/landing/*`
- **zero-docs:** `apps/docs/*`
- **all four also include the shared build roots:** `packages/typescript-config/*`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `package.json`, `patches/*`

`zero-api` bundles `apps/agent-web` as its static assets, so an `agent-web`
change must redeploy the agent Worker (hence it is in `zero-api`'s includes).
Repo-root `docs/` (plans, notes) is documentation only and is intentionally in no
Worker's watch paths — it is **not** the `apps/docs` site, which is what
`zero-docs` watches. When you add a new cross-package dependency to a Worker,
extend that Worker's include list too, or it will silently stop redeploying on
changes to that dependency (a missed include is worse than an over-broad one, so
prefer slightly broader paths).

To deploy manually (e.g. from a branch, without pushing), one Worker at a time.
Each command wraps the build in `zero vault run`, because the web bundle needs
its build-time values and nothing writes them to disk:
```bash
gob run pnpm run deploy:agent      # zero-api
gob run pnpm run deploy:dashboard  # zerovault-api
gob run pnpm run deploy:sites      # landing + docs
```
There is no root `deploy` script: an unwrapped whole-repo deploy would ship a
web bundle built with no values in it.

A deploy reassigns `UserDO` instances to the new Worker version, which resets any
DO mid-turn ("Durable Object reset because its code was updated") and aborts the
in-flight turn. Turns self-heal (the alarm re-fires and replies are persisted
before send, so no duplicates — see `docs/topics.md`), but the user still sees a
delay. To shrink the blast radius, prefer gradual version rollout (Workers
Builds / git connector) so only a slice of DOs reset per step, and **space out
rapid successive pushes** — back-to-back deploys are the worst case for mid-turn
resets.

See `docs/workers-ops.md` for deploy-time Workers ops facts (forcing a deploy to
fail on a missing secret via `secrets.required`, and `custom_domain` route
teardown behavior on deploy).

### CLI releases

The Deployment section above covers Workers only. The npm package
`@zeroapps/cli` (command `zero`) releases separately: pushing a `v*` tag
publishes it from GitHub Actions via npm trusted publishing (OIDC), no token
involved. See `docs/cli-releases.md` for the release steps and constraints.

npm binds that trust to the workflow **filename**
`.github/workflows/publish-cli.yml`. Renaming or moving the file breaks
publishing until the trusted publisher entry on npmjs.com is edited to match.

### Mobile releases

The mobile todo app (`apps/agent-mobile`) releases compatible JavaScript and
assets through EAS Update. A relevant push to `main` publishes to the Android
`preview` channel after CI passes. Native fingerprint changes still use a
sideloadable preview APK built **locally by default** on `mini`; use an EAS cloud
build only when explicitly asked. Publish that APK to the dedicated `Zero Agent
releases` Google Drive folder and replace the previous APK. See
`docs/mobile-releases.md`.

## Architecture

Zero receives Telegram bot webhooks and routes each update to the right user via a KV cache backed by an authoritative `TelegramAccountDO` per Telegram account, consulted whenever KV misses (see `docs/telegram-login.md`). Messages are handled by a two-phase meta-agent that runs inside the per-user `UserDO` Durable Object: an **interface agent** reads the conversation and a topic-based knowledge model (stored in DO SQLite) and replies to the user, then a **writer agent** consolidates what was learned back into the accessed topics. The interface agent, the learner and onboarding are the same runner (`agents/run.ts`) with different prompts and tools; the interface agent investigates the web in its own loop with `web_search` (`WebSearch` port, Brave adapter) and `read_page` (`PageFetcher` port, Tavily adapter). The webhook enqueues each turn and returns 200 immediately; the turn (including any searching) runs inline on a DO alarm. LLM calls go through the Cloudflare AI Gateway (BYOK) with per-user `cf-aig-metadata` attribution; the model is `MODEL_ID` (`gpt-6-luna` on the OpenAI Responses API), and the provider is derived from the model id. The web app is a single screen where a signed-in user links their Telegram account via Telegram's Login Widget (see `docs/telegram-login.md`). A user can also ask Zero to act later, once or on a routine; the schedule record lives in `UserDO` and its deadline in `ScheduleDO`, which queues the schedule's prompt as an ordinary turn when it comes due (see `docs/schedules.md`). Zero also watches Gmail threads it sent for you, and any the user points at, and starts a turn when a reply arrives (see `docs/mail-watch.md`). See `docs/topics.md` for the topic model and writer policy, and `docs/research.md` for web research.

Packages:

- **Worker:** `apps/agent-api` (`@zero/agent-api`)
- **Frontend:** `apps/agent-web` (`@zero/agent-web`)
- **Mobile:** `apps/agent-mobile` (`@zero/agent-mobile`) — Expo (React Native) app. Signs in with Clerk against the **same Clerk instance as web** (one account across web and mobile). Routine releases publish compatible JavaScript and assets to the EAS `preview` channel after green `main` CI. Native fingerprint changes use a preview APK built **locally by default** on `mini` with a Nix dev shell; use an EAS cloud build only when explicitly asked. Publish the APK to a dedicated Google Drive folder and replace the previous APK. See `docs/mobile-releases.md` for the release process and `apps/agent-mobile/README.md` for the local build toolchain. A todo app (the Todoist replacement, intended to become the main surface) is being built on this app plus `apps/agent-api`; its vision, decisions, and build order live in `docs/todo-app.md` — read and update it when working on todos.
- **Shared types:** `packages/agent-core` (`@zero/agent-core`) — currently empty placeholder
- **E2E tests:** `packages/agent-e2e` (`@zero/agent-e2e`) — end-to-end tests against a local worker with mock Telegram and OpenAI servers; run via `bin/e2e-test`. See `docs/e2e-tests.md`
- **Dashboard Worker:** `apps/vault-api` (`@zero/dashboard-api`, Worker `zerovault-api`) serves the unified dashboard at `dash.zeroapps.dev` and public API at `api.zeroapps.dev`. It retains Vault state and adds a fresh Errors Durable Object namespace. Backed by `packages/vault-core` (`@zero/vault-core`) and `packages/errors-core` (`@zero/errors-core`).
- **Dashboard frontend:** `apps/dashboard-web` (`@zero/dashboard-web`) serves Vault at `/vault/*` and Errors at `/errors/*`.
- **Landing site:** `apps/landing` (`@zero/landing`) is a static Astro site served by the asset-only Worker `zero-landing` for `zeroapps.dev`. `astro build` ships zero client JS with CSS inlined into `<head>`; unknown paths get a real 404 (`not_found_handling: 404-page`). It has no runtime secrets or API. It auto-deploys on push to `main` via its own Workers Builds connector (attached 2026-07-26).
- **Docs site:** `apps/docs` (`@zero/docs`) is a static Astro + Starlight site served by the asset-only Worker `zero-docs` for `docs.zeroapps.dev`. It documents ZeroVault and ZeroErrors and ships per-page raw-markdown twins (bare `<page>.md`, e.g. `/vault/overview.md`) with a Copy Markdown button, plus `/llms.txt`, `/llms-full.txt`, `/llms-small.txt`. Unknown paths get a real 404 (`not_found_handling: 404-page`). Unlike landing it ships Starlight's own theme JS and a Pagefind search index (the zero-JS invariant is landing-only). The content is real and the site is indexable: no page carries a `noindex` or `nofollow` directive, `robots.txt` is `Allow: /` and declares `https://docs.zeroapps.dev/sitemap-index.xml`, and that sitemap lists exactly the HTML pages, never the `.md` twins or the `llms*.txt` files. It is submitted to Google Search Console under the `sc-domain:zeroapps.dev` property, which covers both `zeroapps.dev` and `docs.zeroapps.dev`. No runtime secrets or API. Build/deploy are package-scoped (`pnpm -F @zero/docs ...`), never the whole-repo build. Auto-deploys on push to `main` via its own Workers Builds connector.
- **Shared dashboard packages:** `packages/auth` (`@zero/auth`), `packages/ui` (`@zero/ui`), and the published `@zeroapps/cli` (`packages/zero-cli`), whose command is `zero`: `zero vault ...` for secrets, `zero errors ...` for issues, `zero keys` for the org-scoped key both products accept. It replaced `zv` outright, with no alias and no config or env-var migration.

The dashboard uses one Clerk instance whose primary domain is `zeroapps.dev`, with the dashboard on `dash.zeroapps.dev`. The agent is a separate Clerk instance. See `docs/console-auth.md`.

All four deployable Workers (`zero-api`, `zerovault-api`, `zero-landing`, `zero-docs`) auto-deploy on push to `main` via this repo's Cloudflare Workers Builds connectors, each Worker updated in place. Each connector's build watch paths are scoped to that Worker's dependencies (see Deployment → Build watch paths), so a push only redeploys the Workers it affects.

Expected dev ports:

| app | api port | inspector | web (Vite) |
|---|---|---|---|
| agent | 8790 | 9232 | 5176 |
| dashboard | 8792 | 9233 | 5178 |
| landing | 8794 (Workers Assets) | n/a | 5180 |
| docs | 8796 (Workers Assets) | n/a | 5182 |

`pnpm --filter @zero/landing run dev:worker` serves the landing site's built `apps/landing/dist` directory through Workers Assets.

The worker follows a layered architecture: Entry Point → App → Routes → Durable Objects. See `docs/framework.md` and `docs/design.md`.

## Production Logs

Failures the user felt, or that lost work, are also reported as ZeroErrors
issues in project `zero-agent` (`dash.zeroapps.dev/errors`). See
`docs/error-reporting.md` for what reports, at which level, and why Durable
Object resets never do.

```bash
gob add pnpm --dir apps/agent-api exec wrangler tail
```

`wrangler tail` streams live only, so it cannot see a past incident, and on this
box it has produced no output even for a request that returned 200 — always run a
positive control (hit the Worker yourself) before reading silence as "no traffic".

For anything already over, query **Workers Logs** (`observability.enabled` is on
for `zero-api`):

```
POST /accounts/4e04b64af4013414441c59014392bea0/workers/observability/telemetry/query
{"queryId":"q","timeframe":{"from":<ms>,"to":<ms>},
 "parameters":{"datasets":["cloudflare-workers"],
   "filters":[{"key":"$metadata.message","operation":"eq","value":"turn_started","type":"string"}]},
 "limit":100,"view":"events"}
```

- `view: "events"` returns log lines; `view: "invocations"` groups them by
  invocation and adds **`outcome`, `wallTimeMs`, `cpuTimeMs`** — the only way to
  see an `exceededWallTime` kill, which throws nothing and reaches no error sink.
- Group by `$workers.requestId` to read one invocation. Do **not** trust
  `eventType`: a turn's later logs can be attributed to a concurrent `rpc`
  invocation running in the same Durable Object.
- `$workers.event.scheduledTime` on an alarm is the time it was *scheduled*, not
  when it ran. The gap between the two is how alarm delay is measured.
- `limit` caps at **1000** and truncates silently: a query returning exactly
  1000 rows is a truncated query, not a busy hour. A larger value (e.g. 5000)
  returns `success: false`, which reads as zero rows if you only look at
  `result`. Check `success`, and treat 1000 as suspect.
- There is **no aggregation**: counting means fetching events and counting them
  yourself, which the row cap breaks on a busy day. Split the window (per hour,
  per day) and sum the parts.

Brave search spend is countable from Workers Logs: every request to Brave emits
one `brave_request`, and each turn reports its own `searches` /
`unique_queries` on `interface_completed`. See `docs/research.md` (Search usage).
Brave bills 200s only, so the day's bill is the `status: 200` count:

```bash
FROM=$(date -u -d 'today 00:00' +%s)000; TO=$(date +%s)000
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/4e04b64af4013414441c59014392bea0/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"queryId\":\"q\",\"timeframe\":{\"from\":$FROM,\"to\":$TO},
       \"parameters\":{\"datasets\":[\"cloudflare-workers\"],
         \"filters\":[{\"key\":\"\$metadata.message\",\"operation\":\"eq\",\"value\":\"brave_request\",\"type\":\"string\"}]},
       \"limit\":1000,\"view\":\"events\"}" \
  | jq -r '.result.events.events[].source | "\(.status) \(.attempt)"' | sort | uniq -c
```

First column is the count, then `status` and `attempt`: `200 0` is a paid
search, any row with `attempt > 0` is retry cost, and `429` rows are throttling.
Mind the 1000-row cap above — on a heavy day, run it per hour.

Per-LLM-call cost, tokens, cache counts and a `metadata.agent` tag live in the
**AI Gateway** logs instead:

```
GET /accounts/4e04b64af4013414441c59014392bea0/ai-gateway/gateways/zero/logs?per_page=50&order_by=created_at&order_by_direction=desc
```

- `per_page` maxes at 50; a larger value returns `success: false` with an error,
  which looks exactly like an empty page if you only read `result`. Check
  `success`.
- `created_at` is the request **end** time, so a call's start is
  `created_at - duration`.
- These logs **lag** by minutes. Never read recency from them; use Workers Logs
  for "what is happening now".

## Dev Server

Start the dev server manually with `pnpm turbo dev` from the repo root. This launches the agent and dashboard API/web pairs and the landing and docs Astro apps.

If ports are unavailable or an app doesn't load, there may be lingering processes that need to be killed:
```bash
for p in 5176 5178 5180 5182 8790 8792 8794 8796; do lsof -ti :$p | xargs -r kill -9; done
```

Then start the dev server again with `pnpm turbo dev`.

## Secrets

When you need to manage secrets (environment variables, API keys, etc.), refer to `docs/secrets.md` for instructions on how to use ZeroVault. No secret is written to disk: `zero vault run -p <project> -e <env> -- <command>` gives a command its secrets, and `--mount <path>` serves them through a named pipe for tools that read a dotenv file (`wrangler` reading `.dev.vars`). The CLI runs via `pnpm dlx @zeroapps/cli@0.7.0` and needs only the `ZERO_API_KEY` env var; `ZERO_API_URL` is optional and defaults to `https://api.zeroapps.dev` (set it only to target another instance). It is a bare origin: the CLI appends `/vault/v1` or `/errors/v1` itself, so a `/vault` suffix left over from the `zv` era produces 404s.

ZeroVault projects (each with `development` and `production` environments):
- `zero-api` — Worker backend secrets (also used by `bin/e2e-test`)
- `zero-web` — Frontend build-time secrets
