# Plan: `createBot(env)` Telegram factory (architecture-review finding #2)

## Goal

Dedup the 4 copy-pasted grammY `new Bot(...)` constructions in `apps/agent-api` into one `createBot(env)` factory. LATENT BUG: `apps/agent-api/src/telegram/chat-action.ts` is the only Bot construction missing `client: { apiRoot }`, so chat/typing actions ignore `TELEGRAM_API_ROOT`. The factory sets `client: { apiRoot }` from env for ALL call sites, fixing the drift so chat-action honors the configured API root (matters for the e2e mock Telegram server and any custom/self-hosted Bot API root).

## Findings

### The 4 construction sites

All four parse the cached `getMe` JSON from `env.TELEGRAM_BOT_INFO` into `botInfo` and build `new Bot(token, { botInfo, client: { apiRoot } })` — except chat-action, which drops `client.apiRoot`.

| Site | Line | Token | `botInfo` source | `client: { apiRoot }` |
|---|---|---|---|---|
| `src/telegram/chat-action.ts` | 12–13 | `env.TELEGRAM_BOT_TOKEN` | `JSON.parse(env.TELEGRAM_BOT_INFO)` | **MISSING (the drift)** |
| `src/telegram/send-message.ts` | 17–20 | `env.TELEGRAM_BOT_TOKEN` | `JSON.parse(env.TELEGRAM_BOT_INFO)` | `env.TELEGRAM_API_ROOT` ✓ |
| `src/telegram/files.ts` | 20–23 | `env.TELEGRAM_BOT_TOKEN` | `JSON.parse(env.TELEGRAM_BOT_INFO)` | `env.TELEGRAM_API_ROOT` ✓ |
| `src/routes/telegram-webhook.ts` | 326–330 | `c.env.TELEGRAM_BOT_TOKEN` | `JSON.parse(c.env.TELEGRAM_BOT_INFO)` | `c.env.TELEGRAM_API_ROOT` ✓ |

### Confirmed drift

`chat-action.ts:13` is exactly `new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo })` — no `client` key. Correct value is `client: { apiRoot: env.TELEGRAM_API_ROOT }`, matching the other three. `sendChatAction` is called from `UserDO/index.ts:192` (fire-and-forget typing) and wired as `sendTyping` in `telegram-webhook.ts:362`. Because the action targets real Telegram regardless of `TELEGRAM_API_ROOT`, typing indicators never reach the dev/e2e mock server; low-impact, so it went unnoticed.

### Env types

`Env = Cloudflare.Env & { ZEROVAULT_API_KEY?: string }` (`src/types.ts:7`). `Cloudflare.Env` (worker-configuration.d.ts) declares `TELEGRAM_API_ROOT` as the string literal `"https://api.telegram.org"` (`worker-configuration.d.ts:9`, immaterial — a string literal is assignable to the factory's `string` read, leave as-is), `TELEGRAM_BOT_TOKEN: string`, `TELEGRAM_BOT_INFO: string`. All three fields the factory needs are present on `Env`. The webhook route uses `c.env` (a `Bindings: Env` Hono context) which is the same `Env` shape, so `createBot(c.env)` works.

### Test landscape

- `chat-action.test.ts`, `send-message.test.ts`, `files.test.ts` all `vi.mock("grammy", ...)` with a fake `Bot` class exposing spied `api` methods. These mocks replace the constructor entirely, so they **cannot** prove `apiRoot` is honored — they never construct a real grammY client. They stay valid after the refactor (they mock the same `grammy` module the factory imports).
- e2e mock at `packages/agent-e2e/src/mock-telegram.ts` handles `sendChatAction` (returns `{ ok: true }`) but does **not** capture it (no counter/endpoint). e2e runs boot `workerd`, which per AGENTS.md can't run locally on this box — CI only.

## Factory design

**Path:** `apps/agent-api/src/telegram/bot.ts`

**Signature:** `export const createBot = (env: Env): Bot => { ... }`

**Encapsulates** the "how to become the bot" knowledge that is copy-pasted today:
1. Parse `env.TELEGRAM_BOT_INFO` (`JSON.parse` → `UserFromGetMe`).
2. Construct `new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo, client: { apiRoot: env.TELEGRAM_API_ROOT } })`.
3. Return the configured `Bot`.

This is a single-seam in-process consolidation (no port needed — the mock already substitutes at `TELEGRAM_API_ROOT`, so this is not a test boundary). It is finding #2's **S** option (factory only), not the **M** full `TelegramClient`. Callers keep making the grammY `bot.api.*` calls themselves.

## Edits

1. **New** `src/telegram/bot.ts`: the `createBot` factory above (imports `Bot` from `grammy`, `UserFromGetMe` from `grammy/types`, `Env` from `../types`).
2. **`src/telegram/chat-action.ts`**: replace the `botInfo` parse + `new Bot(...)` lines with `const bot = createBot(env);`. Drop the now-unused `Bot` / `UserFromGetMe` imports. **This is the bug fix** — chat-action now gets `client.apiRoot`.
3. **`src/telegram/send-message.ts`**: replace parse + `new Bot(...)` with `const bot = createBot(env);`. Drop unused `Bot` / `UserFromGetMe` imports.
4. **`src/telegram/files.ts`**: replace parse + `new Bot(...)` with `const bot = createBot(env);`. Keep the `env.TELEGRAM_API_ROOT` / `env.TELEGRAM_BOT_TOKEN` usage in the file-download URL (that is a separate raw `fetch`, not the Bot). Drop unused `Bot` / `UserFromGetMe` imports.
5. **`src/routes/telegram-webhook.ts`**: replace the parse + `new Bot(...)` (lines 326–330) with `const bot = createBot(c.env);`. Import cleanup (grep-confirmed): `import { Bot, webhookCallback } from "grammy"` (`:18`) still uses `webhookCallback` at `:376`, so **keep `webhookCallback` and drop only `Bot`**. `UserFromGetMe` (`:19`) is used only at the old `:326` construction, so drop it too.

## Bug-fix proof

The existing `grammy`-mock unit tests can't prove `apiRoot`. Add a focused factory test that exercises a **real** grammY client against a local listener. The fix is driven by `client.apiRoot`, not `botInfo` — a direct `bot.api.sendChatAction` call issues no `getMe` (getMe only fires from `bot.init()`/`start()`), so `botInfo` is inert for this test. The factory still sets `botInfo` to match the other sites, but the test's assertion power comes entirely from `apiRoot`.

**`src/telegram/bot.test.ts`** (vitest, node — no workerd, runs locally):
- Start a throwaway HTTP server on an ephemeral port that records each request path and returns `{ ok: true, result: true }` for any `POST /bot*/sendChatAction`.
- Build `env` with `TELEGRAM_API_ROOT` set to the listener origin `http://127.0.0.1:<port>` — **no trailing slash**; grammY throws when `apiRoot` ends in `/` (`out/core/client.js:86-87`). Use a dummy token (`TESTTOKEN`) and valid `TELEGRAM_BOT_INFO`.
- Do **not** mock `grammy` in this file.

**Committed test = the GREEN case.** Call `createBot(env).api.sendChatAction(100, "typing")` and assert the listener recorded **exactly one** request with path `/botTESTTOKEN/sendChatAction` and **no** `getMe`. This is the factory-built bot honoring `TELEGRAM_API_ROOT`.

**RED demonstration (manual, not committed as a passing assertion).** To show the pre-fix chat-action shape (`new Bot(token, { botInfo })`, no `apiRoot`) is broken, grammY routes to `api.telegram.org`, not the local listener. That triggers a **real outbound network call**. Wrap it so a network reject can't be mistaken for the failure:

```
try { await oldShapeBot.api.sendChatAction(100, "typing"); } catch {}
expect(listenerHits).toHaveLength(0); // red is for the RIGHT reason: apiRoot ignored, not a network error
```

The assertion is that the **local** listener saw nothing (0 hits) — red because `apiRoot` was ignored, not because the outbound call failed. Never let the red path assert on a real `api.telegram.org` response.

This directly proves chat/typing actions now honor `TELEGRAM_API_ROOT`, without needing workerd or the e2e harness, and without any committed test depending on real network access.

**Optional (defer):** extend `mock-telegram.ts` to count `sendChatAction` and assert in an e2e turn test that a typing action reached the mock. Higher cost, workerd/CI-only, and redundant with the factory unit test — skip unless the e2e capture is wanted for its own sake.

Keep the three existing `grammy`-mock tests as-is; they still cover the per-caller behavior (thread-id handling, error logging).

## Test / lint / typecheck

Per AGENTS.md, verify the touched package directly (workerd suites run in CI):

```
pnpm --filter @zero/agent-api run test
pnpm --filter @zero/agent-api run lint
pnpm --filter @zero/agent-api run typecheck
```

Whole-repo `gob run bin/ci` and the e2e suite are workerd-backed and defer to GitHub Actions CI + the Cloudflare deploy.

## Changelog decision

**No changelog entry.** Per AGENTS.md, purely internal changes get no entry. In normal production the API root is the default `https://api.telegram.org`, so the chat-action fix is invisible to users; it only matters for the e2e mock and custom/self-hosted Bot API roots — infra, not user-facing. Finding #2 itself calls it "changelog-free internal." The dedup is a refactor. State: internal, no entry.

## Skills to use

- `tdd` — write `bot.test.ts` (red against current chat-action shape, green after the factory) before wiring the other call sites.
- `git-commit` — when committing.

## Acceptance criteria

- `src/telegram/bot.ts` exports `createBot(env: Env): Bot` that owns the `botInfo` parse + `client.apiRoot` wiring.
- All 4 sites (`chat-action.ts`, `send-message.ts`, `files.ts`, `telegram-webhook.ts`) construct their Bot via `createBot`; no remaining `new Bot(` in `apps/agent-api/src`.
- `chat-action` Bot now carries `client: { apiRoot: env.TELEGRAM_API_ROOT }` (drift removed).
- `bot.test.ts` (committed, GREEN case) asserts the factory-built bot's `sendChatAction` hits the local listener at `/botTESTTOKEN/sendChatAction` — exactly one call, no `getMe` — proving it honors `TELEGRAM_API_ROOT`. No trailing slash on the configured root. No committed test depends on a real `api.telegram.org` call.
- The 3 existing `grammy`-mock tests still pass unchanged.
- `pnpm --filter @zero/agent-api run test | lint | typecheck` all pass.
- No changelog entry.
