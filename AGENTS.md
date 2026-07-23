# Instructions for AI Agents

## Development

During development, use `gob run bin/ci` to run all necessary checks including build, linter, tests etc.

**Mobile (`apps/agent-mobile`):** unit tests, lint, and typecheck run in the Turbo pipeline like the other packages. Automated **UI tests run on an Android emulator with Maestro**, but only in the **Mobile E2E** GitHub Actions workflow (`.github/workflows/mobile-e2e.yml`, manual dispatch) — the dev box has no KVM to run an emulator locally. Every run uploads a screenshot, logcat, and UI hierarchy as artifacts, so on-device failures are reproducible without a phone. Flows live in `apps/agent-mobile/.maestro/`. See `apps/agent-mobile/README.md`.

**Local `workerd` limitation:** on dev boxes where the `workerd` binary can't start (e.g. NixOS), `gob run bin/ci` and `bin/e2e-test` can't run whole-repo: the untouched vault/errors workers, the deploy dry-run, and the e2e suite all boot `workerd`. Fallback: verify the touched package directly, e.g. `pnpm --filter @zero/agent-api run test`, plus `pnpm --filter @zero/agent-api run lint` and `pnpm --filter @zero/agent-api run typecheck`. Rely on GitHub Actions CI and the Cloudflare deploy to run the `workerd`-backed suites (e2e, cross-worker build/typecheck).

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

- **Agent (Zero assistant):** changes to `apps/agent-api`, the Telegram bot, or
  the `apps/agent-mobile` app go in `apps/agent-api/CHANGELOG.md`.
- **ZeroVault / ZeroErrors / console:** changes to `apps/vault-*`, `apps/errors-*`,
  or shared console UI go in the root `CHANGELOG.md`.

`apps/agent-api/CHANGELOG.md` is bundled and surfaced in-product as Zero's
read-only "Changelog" system topic (`apps/agent-api/src/store/system-topics.ts`),
so its entries ship to agent users on the next deploy. Keep them clean and
user-facing. The root `CHANGELOG.md` has no in-product surface today; it is the
console's human-readable changelog. **Do not mix console entries into the agent
file** — that is exactly what this split fixed.

## Deployment

Pushing to `main` auto-deploys to production via the Cloudflare Git
connector (Workers Builds). No manual step is needed; after pushing,
wait for the Cloudflare build to finish. GitHub Actions CI only lints,
typechecks, tests, and runs a deploy dry-run; it does not deploy.

To deploy manually (e.g. from a branch, without pushing):
```bash
gob run bin/deploy
```

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

## Architecture

Zero receives Telegram bot webhooks and routes each update to the right user via KV. Messages are handled by a two-phase meta-agent that runs inside the per-user `UserDO` Durable Object: an **interface agent** reads the conversation and a topic-based knowledge model (stored in DO SQLite) and replies to the user, then a **writer agent** consolidates what was learned back into the accessed topics. The interface agent and a **research agent** are the same runner (`agents/run.ts`) with different prompts and tools; the interface agent can call a `research` tool that spawns the research agent with web search (`WebSearch` port, Brave adapter) and returns its final message. The webhook enqueues each turn and returns 200 immediately; the turn (including any research loop) runs inline on a DO alarm. LLM calls go through the Cloudflare AI Gateway (BYOK Anthropic) with per-user `cf-aig-metadata` attribution. The web app is a single screen where a signed-in user links their Telegram account via Telegram's Login Widget (see `docs/telegram-login.md`). See `docs/topics.md` for the topic model and writer policy, and `docs/research.md` for the research agent.

Packages:

- **Worker:** `apps/agent-api` (`@zero/agent-api`)
- **Frontend:** `apps/agent-web` (`@zero/agent-web`)
- **Mobile:** `apps/agent-mobile` (`@zero/agent-mobile`) — Expo (React Native) app. Signs in with Clerk against the **same Clerk instance as web** (one account across web and mobile). Built and distributed via EAS (no local Android SDK). See `apps/agent-mobile/README.md`.
- **Shared types:** `packages/agent-core` (`@zero/agent-core`) — currently empty placeholder
- **E2E tests:** `packages/agent-e2e` (`@zero/agent-e2e`) — end-to-end tests against a local worker with mock Telegram and Anthropic servers; run via `bin/e2e-test`. See `docs/e2e-tests.md`
- **ZeroVault:** `apps/vault-api` (`@zero/vault-api`, worker `zerovault-api`, `vault.apps.juanibiapina.dev`) + `apps/vault-web` (`@zero/vault-web`) — secrets manager this repo bootstraps from. Backed by `packages/vault-core` (`@zero/vault-core`).
- **ZeroErrors:** `apps/errors-api` (`@zero/errors-api`, worker `zeroerrors-api`, `zeroerrors.juanibiapina.dev`) + `apps/errors-web` (`@zero/errors-web`) — error tracking. Backed by `packages/errors-core` (`@zero/errors-core`).
- **Shared vault/errors packages:** `packages/auth` (`@zero/auth`), `packages/ui` (`@zero/ui`), and the published `zerovault-cli` (`packages/zerovault-cli`, npm name unchanged).

The console (ZeroVault + ZeroErrors) shares one Clerk instance whose primary domain is `apps.juanibiapina.dev`; both web apps must be served on subdomains of it (`vault.apps.`, `errors.apps.`) to hold a session. The agent is a separate Clerk instance. See `docs/console-auth.md`.

All three products (agent, vault, errors) auto-deploy on push to `main` via this repo's Cloudflare Workers Builds connector, each worker updated in place.

Expected dev ports:

| app | api port | inspector | web (Vite) |
|---|---|---|---|
| agent | 8790 | 9232 | 5176 |
| errors | 8791 | 9234 | 5177 |
| vault | 8792 | 9233 | 5178 |

The worker follows a layered architecture: Entry Point → App → Routes → Durable Objects. See `docs/framework.md` and `docs/design.md`.

## Production Logs

```bash
gob add pnpm --dir apps/agent-api exec wrangler tail
```

## Dev Server

Start the dev server manually with `pnpm turbo dev` from the repo root. This launches every app's dev server (agent, vault, errors: 3 apis + 3 webs).

If ports are unavailable or an app doesn't load, there may be lingering processes that need to be killed:
```bash
for p in 5176 5177 5178 8790 8791 8792; do lsof -ti :$p | xargs -r kill -9; done
```

Then start the dev server again with `pnpm turbo dev`.

## Secrets

When you need to manage secrets (environment variables, API keys, etc.), refer to `docs/secrets.md` for instructions on how to use ZeroVault. The CLI runs via `pnpm dlx zerovault-cli@0.2.1` and needs only the `ZEROVAULT_API_KEY` env var; `ZEROVAULT_API_URL` is optional and defaults to `https://vault.apps.juanibiapina.dev` (set it only to target another instance).

ZeroVault projects (each with `development` and `production` environments):
- `zero-api` — Worker backend secrets (also used by `bin/e2e-test`)
- `zero-web` — Frontend build-time secrets
