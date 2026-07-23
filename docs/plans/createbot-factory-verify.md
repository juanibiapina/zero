# Verify: `createBot(env)` Telegram factory plan

Verdict: **GO**. No blockers. 0 blockers, 3 concerns, 3 nits. The refactor is behavior-preserving for the 3 correct sites, and the bug-fix test approach is empirically sound (proven red/green with a throwaway probe).

## Evidence gathered

- Independent grep: exactly **4** `new Bot(` sites in `apps/agent-api/src` (`rg -c` → 1 each in `chat-action.ts`, `send-message.ts`, `files.ts`, `routes/telegram-webhook.ts`).
- Probe: built a real grammY `Bot` (v1.45.1) against a `node:http` listener on an ephemeral port. WITH `client.apiRoot` → listener received exactly `["/botTESTTOKEN/sendChatAction"]` (one call, no getMe). WITHOUT `apiRoot` → **0** hits. Confirms the test goes red on the old shape and green after, and that a direct `bot.api.*` call triggers no `getMe`.
- grammY internals: `out/core/client.js:151` `defaultBuildUrl` = `` `${root}/bot${token}/${prefix}${method}` `` (path matches plan). `:65` default apiRoot = `https://api.telegram.org` (old chat-action hits real Telegram). `:86-87` a **trailing slash** on `apiRoot` throws.
- vitest env: `apps/agent-api/vitest.config.ts` is plain `vitest/config` (no `@cloudflare/vitest-pool-workers`), so `node:http` + global `fetch` work locally as the plan assumes.

## Findings

### Blockers
None.

### Concerns

1. **RED demonstration makes a real outbound call.** Against the pre-fix shape, grammY sends to `api.telegram.org` with the dummy token. Under a network-restricted CI the promise rejects; if `bot.test.ts` doesn't wrap the call, the red run errors ambiguously instead of asserting "listener not hit". Fix: in the test, `try { await ... } catch {}` and assert the listener recorded nothing (as the probe did). This keeps the red for the right reason and avoids a flaky network dependency. (This only matters if you manually demo red; the committed test is the green case.)

2. **Test must not add a trailing slash to `TELEGRAM_API_ROOT`.** grammY throws on `apiRoot` ending in `/` (`client.js:86-87`). Plan's example uses `http://127.0.0.1:<port>` (no slash) — correct, but call it out explicitly in the test so a future edit doesn't append `/`.

3. **`botInfo` is not what routes the call** — it's `client.apiRoot`. The plan's framing is right, but note the test's assertion power comes entirely from `apiRoot`; `botInfo` is inert for a direct `bot.api.*` call (getMe is only issued by `bot.init()`/`start()`, never here). No change needed; just don't attribute the fix to `botInfo`.

### Nits

1. **Env type detail:** plan says `worker-configuration.d.ts` declares `TELEGRAM_API_ROOT: string`; it is actually the literal `"https://api.telegram.org"` (`worker-configuration.d.ts:9`). Harmless — a string literal is assignable to the factory's `string` read. No impact.

2. **Webhook import cleanup:** `telegram-webhook.ts:18` is `import { Bot, webhookCallback } from "grammy"`. `webhookCallback` is still used (`:376`), so drop only `Bot`; `UserFromGetMe` (`:19`) is used only at `:326` and can go. The plan already says "verify with a grep before removing" — grep confirms this split. Keep `webhookCallback`.

3. **`files.ts` keeps its raw URL.** `files.ts:26` builds `${env.TELEGRAM_API_ROOT}/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}` via a separate `fetch` (not the Bot). The plan flags this; leave it. `files.test.ts` asserts that exact URL, so don't touch it.

## Per-question answers

1. **4 sites / table accuracy:** Confirmed 4. Lines match (chat-action 12-13, send-message 17-20, files 20-23, webhook 326-330). `chat-action.ts:13` = `new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo })` is the **only** one missing `client.apiRoot`. The other 3 pass `client: { apiRoot: <env>.TELEGRAM_API_ROOT }` **identically** (webhook uses `c.env`). Table is accurate.

2. **Signature works at all 4:** Yes. All sites read from an `Env`-shaped value; the webhook's `c.env` is `Bindings: Env` (`OpenAPIHono<{ Bindings: Env }>`), same shape. No site passes extra/different Bot options — all three correct sites pass exactly `{ botInfo, client: { apiRoot } }`. `createBot(env)` reproduces that with no behavior change.

3. **Bug-fix test real and sound:** Yes, proven empirically (see probe above). grammY routes through `apiRoot`, builds `/bot<token>/sendChatAction`, and issues no getMe on a direct api call. Test can't pass trivially (0 hits without the fix) and won't fail for the wrong reason as long as the red demo swallows the outbound rejection (concern 1) and no trailing slash is used (concern 2).

4. **Existing 3 mocked tests hold:** Yes. `chat-action.test.ts`, `send-message.test.ts`, `files.test.ts` each `vi.mock("grammy")` with a fake `Bot` class that ignores constructor args and exposes only spied `api` methods. None assert the construction shape. They import the same `grammy` the factory imports, so the mock still applies after routing through `createBot`. Unchanged.

5. **"No changelog" correct:** Yes. In prod `TELEGRAM_API_ROOT` is the default `https://api.telegram.org`, so the chat-action fix is invisible to users (only affects e2e mock / self-hosted Bot API). Refactor + internal. The root `CHANGELOG.md` is console-only and user-facing; this is agent-internal. No entry, per AGENTS.md.

6. **Behavior change for the 3 correct sites:** None. All three already construct with `botInfo` present; none omit it to force a getMe (getMe is never called on this code path anyway). The factory emits the identical options object. No drift.

## Suggested plan edits

- Add to the `bot.test.ts` spec: wrap the `sendChatAction` call in `try/catch` for the red demo, and assert the listener recorded the request (not just that the promise resolved). Note the no-trailing-slash requirement on `TELEGRAM_API_ROOT`.
- Correct the env note: `TELEGRAM_API_ROOT` is typed as the literal `"https://api.telegram.org"`, not `string` (immaterial to the factory).
- Under edit #5, state the outcome of the grep: keep `webhookCallback`, drop `Bot` and `UserFromGetMe`.
