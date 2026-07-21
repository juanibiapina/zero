# Plan: clear message when the LLM quota / rate limit is reached

## Goal

When an LLM call through the Cloudflare AI Gateway fails because the account is
rate-limited or has hit a usage/spend cap (HTTP 429, or the transient overloaded
529), the user should get a clear, honest message telling them the assistant is
temporarily at its usage limit — instead of today's generic
"Sorry, I couldn't finish that one. Could you try again?" which invites a
pointless immediate retry.

## Background found during research

### Where a turn runs and where errors are caught

A turn runs inside `UserDO` on a DO alarm, which calls
`runAlarmTurns` (`apps/agent-api/src/do/alarm.ts`) → `runTurn`
(`apps/agent-api/src/agents/orchestrator.ts`).

`runTurn` wraps the whole agent path in one try/catch. On any thrown error it
sends a fixed fallback and persists it as an assistant message so the thread
stops awaiting reply (this is deliberate: it prevents an alarm retry storm on a
"poison" turn). The relevant block (`orchestrator.ts`, currently lines ~112–128):

```ts
  } catch (err) {
    // The agent path threw (LLM gateway error, malformed tool loop, etc.).
    // Tell the user and persist the fallback ...
    logError("turn_failed", {
      chat_id: chatId,
      topic_id: topicId,
      error: fmtErr(err),
    });
    await send(FALLBACK_MESSAGE);
    store.storeMessage(conversationId, "assistant", FALLBACK_MESSAGE);
  } finally {
    store.clearBusy(conversationId);
  }
```

`FALLBACK_MESSAGE` is defined in `apps/agent-api/src/agents/interface.ts`:

```ts
export const FALLBACK_MESSAGE =
  "Sorry, I couldn't finish that one. Could you try again?";
```

`send` is the Telegram sink wired by the DO; the string handed to it is what the
user sees. So the single, correct place to branch on a quota/rate-limit error is
this `catch` in `runTurn`.

Note there are two fallback sources:
1. `interface.ts` sends `FALLBACK_MESSAGE` for a *clean* incomplete turn (step
   cap hit, empty final text) — no exception thrown. This is NOT a quota case
   and must stay unchanged.
2. `orchestrator.ts` catch handles *thrown* errors — this is where LLM API
   failures (including 429/529) land. Only this path changes.

### How a 429 reaches the orchestrator catch

LLM calls go through one seam, `runAgent` in `apps/agent-api/src/agents/run.ts`,
which calls the AI SDK `generateText`. The model is built in
`apps/agent-api/src/agents/model.ts` (`createModelFactory`) against the AI
Gateway (BYOK Anthropic).

The interface agent (`interface.ts`) calls `runAgent` directly. A thrown error
from that top-level `generateText` propagates out of `runInterfaceAgent` and is
caught by `runTurn`. This is the dominant path: a real account-wide 429 hits the
interface agent's own `generateText` and propagates, so the user gets
`RATE_LIMIT_MESSAGE`.

The research tool (`apps/agent-api/src/tools/research.ts`, `execute`) also calls
`runAgent`, but a 429 thrown *inside a tool `execute`* does NOT reach the
orchestrator catch. In `generateText`'s tool loop a thrown tool `execute` is
caught by the AI SDK and converted to a `tool-error` content part fed back to the
model — it is not rethrown and no `ToolExecutionError` is produced. `interface.ts`
documents exactly this (`recordingSend` re-raises a swallowed send failure
specifically because "a thrown tool execute becomes a tool-error fed back to the
model, not a rejected generateText"). Consequently the `.cause` unwrap in the
classifier below is **dead for the research path**: it is kept only as cheap
defensive code against future SDK versions or other wrappers, not because a
research 429 flows through it. A research-triggered account 429 still surfaces to
the user because the same cap also fails the interface agent's own top-level
`generateText` call.

### How an Anthropic rate-limit / quota error manifests through the SDK (cited)

The Anthropic provider parses an HTTP error body with this schema and turns it
into an `APICallError` carrying `statusCode`, `responseHeaders`, `responseBody`,
and `data`
(`node_modules/@ai-sdk/anthropic/.../dist/index.js`):

```js
var anthropicErrorDataSchema = ... z.object({
  type: z.literal("error"),
  error: z.object({ type: z.string(), message: z.string() }),
});
var anthropicFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: anthropicErrorDataSchema,
  errorToMessage: (data) => data.error.message,
});
```

`createJsonErrorResponseHandler`
(`@ai-sdk/provider-utils/.../dist/index.js`) builds
`new APICallError({ statusCode: response.status, responseHeaders, responseBody, data: parsedError, ... })`.

`APICallError` (`@ai-sdk/provider/.../dist/index.js`) defaults `isRetryable` to
true for 408/409/429/≥500:

```js
isRetryable = statusCode != null && (statusCode === 408 ||
  statusCode === 409 || statusCode === 429 || statusCode >= 500),
```

Because a 429 is retryable, `generateText` (default `maxRetries: 2`) retries with
exponential backoff (initial 2s, ×2), and the AI SDK `shouldRetry` only retries
when `error.isRetryable === true`
(`ai/.../dist/index.js`: `APICallError.isInstance(error) && error.isRetryable === true`).
After the retries are exhausted it throws an `AI_RetryError` whose `.lastError`
is the final `APICallError`.

Anthropic overloaded errors surface as **529**. In the streaming path the
provider maps `error.type === "overloaded_error"` to
`statusCode: 529, isRetryable: true` (anthropic dist, ~line 5414).

The repo already knows this shape. `fmtErr` in `apps/agent-api/src/log.ts`
unwraps the retry wrapper and pulls out exactly the fields we need:

```ts
// AI_RetryError wraps the final upstream failure in `lastError`; unwrap so the
// API-level detail (status, headers) is what we report.
const apiErr =
  "lastError" in err && err.lastError instanceof Error ? err.lastError : err;
...
if (typeof e.statusCode === "number") base.statusCode = e.statusCode;
...
const rl = pickRateLimitHeaders(e.responseHeaders); // ratelimit|retry-after|cf-aig|cf-ray
if (typeof e.responseBody === "string") base.responseBody = e.responseBody.slice(0, 500);
```

`fmtErr`'s comments confirm the two sources of a 429 we care about: Anthropic
429s carry `anthropic-ratelimit-*` + `retry-after`; a Cloudflare AI Gateway
throttle/cap carries `cf-aig-*` / `cf-ray`.

### Quota-cap vs transient rate limit — what the API actually lets us tell apart

There is no clean, reliable separation on the wire:

- Anthropic returns **HTTP 429** with body `error.type === "rate_limit_error"`
  for both short-term rate limiting and sustained overuse. Hard billing/credit
  problems can instead come back as **400** `invalid_request_error` mentioning
  the credit balance — not a 429 — so they are out of scope for a "rate limit"
  branch.
- The Cloudflare AI Gateway spend-limit / budget cap surfaces as a **429** too,
  distinguishable only heuristically by `cf-aig-*` headers on the response.
- **529** is explicitly transient ("overloaded").

Decision: **do not try to draw a firm quota-cap vs transient line in the UI.**
Both 429 and 529 map to one honest message that fits either case ("temporarily
at my usage limit, try again in a little while"). Attempting a confident
"you are out of quota" claim risks being wrong (a 60-second rate limit reported
as a hard cap). We keep the distinction only in logs (status code + rate-limit
headers, already captured by `fmtErr`) for operators. This is recorded as an
explicit choice, not an oversight.

## What to change and why

### 1. New pure classifier — `apps/agent-api/src/agents/llm-error.ts`

A small deep module: given an unknown thrown error, decide whether it is an LLM
rate-limit / quota / overloaded condition. Pure and unit-testable; no I/O.

```ts
// Classifies a thrown turn error as an LLM capacity condition (rate limit,
// usage/spend cap, or transient overload) so the orchestrator can show a
// clear message instead of the generic fallback. Pure.

// Walk .lastError (AI_RetryError) and .cause (ToolExecutionError, wrapped
// fetch errors) to find an underlying API error's status code.
const statusOf = (err: unknown, depth = 0): number | undefined => {
  if (depth > 5 || !err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.statusCode === "number") return e.statusCode;
  return statusOf(e.lastError, depth + 1) ?? statusOf(e.cause, depth + 1);
};

export const isRateLimitError = (err: unknown): boolean => {
  const status = statusOf(err);
  return status === 429 || status === 529;
};

export const RATE_LIMIT_MESSAGE =
  "I've hit my usage limit for now, so I can't get to that just yet. " +
  "Please try again in a little while.";
```

Rationale for a recursive `statusOf` rather than reusing `fmtErr`: `fmtErr`
unwraps only `.lastError`, which is the real path we need — an interface-agent
429 arrives as an `AI_RetryError` whose `.lastError` is the final `APICallError`.
The `.cause` walk is cheap defensive code (for `ToolExecutionError`-style or
wrapped-fetch errors) and is not exercised by the research path (see "How a 429
reaches the orchestrator catch" — a tool-thrown 429 becomes a `tool-error`, never
a rethrow). `fmtErr` stays as the logging formatter.

### 2. Branch in the orchestrator catch — `apps/agent-api/src/agents/orchestrator.ts`

Import the classifier and message, and pick the reply in the existing `catch`.
Persisting the message (same as today) is kept intentionally: it stops the
thread awaiting reply and avoids an alarm retry storm against an account that is
capped. Use a distinct log msg so operators can alert on it.

```ts
import { isRateLimitError, RATE_LIMIT_MESSAGE } from "./llm-error";
...
  } catch (err) {
    const rateLimited = isRateLimitError(err);
    logError(rateLimited ? "turn_rate_limited" : "turn_failed", {
      chat_id: chatId,
      topic_id: topicId,
      error: fmtErr(err),
    });
    const reply = rateLimited ? RATE_LIMIT_MESSAGE : FALLBACK_MESSAGE;
    await send(reply);
    store.storeMessage(conversationId, "assistant", reply);
  } finally {
    store.clearBusy(conversationId);
  }
```

`fmtErr(err)` still logs the status code and rate-limit headers, so
quota-vs-transient stays visible to operators even though the user message is
unified.

### Behavior summary

| Condition | Detection | User sees | Persisted? | Retry |
|---|---|---|---|---|
| Anthropic 429 `rate_limit_error` | statusCode 429 | `RATE_LIMIT_MESSAGE` | yes | none (user resends) |
| AI Gateway spend cap | statusCode 429 (`cf-aig-*` in logs) | `RATE_LIMIT_MESSAGE` | yes | none |
| Overloaded 529 | statusCode 529 | `RATE_LIMIT_MESSAGE` | yes | none |
| Any other thrown error | not 429/529 | `FALLBACK_MESSAGE` (unchanged) | yes | none |
| Clean incomplete turn (step cap / empty) | no throw | `FALLBACK_MESSAGE` (unchanged) | yes | none |

Alternative considered — auto-retry transient 429s by rethrowing so the alarm
reschedules with backoff (`alarm.ts` already does bounded exponential backoff to
5 min). Rejected for this change: a sustained cap would loop paid alarms up to
the backoff ceiling forever (the alarm only stops once the thread tail is
`assistant`), which is exactly the retry-storm the persist-fallback guard
prevents. The AI SDK already retries a 429 twice in-process before we ever get
here. Keep the change small and consistent; revisit auto-retry separately if
transient 429s prove common in logs.

## User-facing message wording

> I've hit my usage limit for now, so I can't get to that just yet. Please try again in a little while.

Honest, no internal jargon ("quota", "429", "Anthropic", "gateway"), covers both
a short rate limit and a usage cap, and does not over-promise a specific
recovery time.

## CHANGELOG.md entry

Add as the top bullet (most recent first):

```
- 2026-07-21: When the assistant is temporarily at its usage limit, it now tells you clearly and asks you to try again shortly, instead of a generic error.
```

## Test plan

### Unit — `apps/agent-api/src/agents/llm-error.test.ts` (new)

Cover `isRateLimitError`:
- Bare `APICallError`-like `{ statusCode: 429 }` → true.
- `{ statusCode: 529 }` → true.
- `AI_RetryError`-like `{ lastError: { statusCode: 429 } }` → true (retry wrap).
- `ToolExecutionError`-like `{ cause: { statusCode: 429 } }` → true. Keep this
  case, but note it guards the `.cause` walk defensively — the research path does
  not actually deliver a 429 this way (a tool-thrown 429 becomes a `tool-error`,
  not a rethrow; see background). It protects against future SDK wrappers.
- Nested `{ lastError: { cause: { statusCode: 529 } } }` → true.
- `{ statusCode: 400 }`, plain `Error("boom")`, `undefined`, `null` → false.
- Cyclic / very deep object → false, no infinite loop (depth guard).

Construct real `APICallError` via `import { APICallError } from "ai"` where
convenient to guard against SDK field renames, plus plain-object cases for the
wrappers.

### Unit — `apps/agent-api/src/agents/orchestrator.test.ts` (extend)

Mirror the existing "delivers a fallback ... when the agent throws" test
(around line 205), but make `doGenerate` throw a **non-retryable** error that
still carries statusCode 429.

Critical: do NOT throw a default `APICallError` with `statusCode: 429`. A 429
`APICallError` defaults `isRetryable` to true, so `generateText` (in `runAgent`)
retries it twice with exponential backoff; with a `retry-after: 30` header the
SDK waits ~30s per retry, blowing past vitest's default 5000ms timeout and
hanging the test. Throw a non-retryable carrier instead:

```ts
// Simplest: a plain object/Error carrying statusCode 429. Not an APICallError,
// so the SDK's shouldRetry (APICallError.isInstance && isRetryable) is false.
const model = new MockLanguageModelV3({
  doGenerate: async () => {
    throw Object.assign(new Error("rate limited"), { statusCode: 429 });
  },
});
```

or, to exercise the real `APICallError` shape while staying non-retryable:

```ts
import { APICallError } from "ai";
const model = new MockLanguageModelV3({
  doGenerate: async () => {
    throw new APICallError({
      message: "rate limited",
      url: "https://gateway/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: false, // force non-retryable so no 30s backoff wait
      responseHeaders: { "retry-after": "30" },
      responseBody: '{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
    });
  },
});
```

The classifier keys on statusCode regardless of `isRetryable`, so either form
still classifies as a rate limit.

Assert:
- `sink.sent` equals `[RATE_LIMIT_MESSAGE]` (not `FALLBACK_MESSAGE`).
- History tail is the persisted `RATE_LIMIT_MESSAGE`, thread no longer awaiting
  reply (`findThreadsAwaitingReply()` empty).
- A `turn_rate_limited` error log was emitted (spy on `console.error`).
- Keep the existing non-429 "gateway down" test asserting `FALLBACK_MESSAGE` +
  `turn_failed`. That test stays fast because it throws a plain `Error`, which is
  not an `APICallError` and so is never retried by the SDK.

### E2E — `packages/agent-e2e` (mock 429 support + one test)

Harness note (so the implementer isn't surprised): `mock-anthropic.ts`'s success
path returns a **200 SSE** body (`text/event-stream`), but the worker uses
non-streaming `generateText`, whose 200 success handler JSON-parses the body. The
SSE text is not valid JSON, so the mock's "success" response actually throws a
200 parse-error inside the worker, and the baseline e2e reply is already
`FALLBACK_MESSAGE`. `hello.test.ts` hides this by only asserting the reply is
truthy. This does not affect the 429 test: a 429 is still distinguishable (the
classifier keys on statusCode 429, producing `RATE_LIMIT_MESSAGE`, which differs
from `FALLBACK_MESSAGE`). No need to fix the success path for this change; just
know the baseline reply is a fallback, not a real assistant message.

`packages/agent-e2e/src/mock-anthropic.ts` currently always returns a 200 SSE
body. Add a mutable mode toggle mirroring mock-telegram's `/test/messages`
control endpoints:

- `POST /test/mode` `{ "mode": "rate_limit" }` sets a module-level flag;
  `DELETE /test/mode` resets to normal.
- In `POST /v1/messages`, when the flag is set, return HTTP **429** with
  `content-type: application/json`, body
  `{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}`,
  and headers `retry-after: 1`, `anthropic-ratelimit-requests-remaining: 0` so
  the logged shape matches production.

New test `packages/agent-e2e/src/rate-limit.test.ts`. Reuse the same setup as
`hello.test.ts`: the shared `./helpers` (`buildWebhookUpdate`, `pollForMessage`)
and the same env-derived URLs (`WORKER_URL`, `MOCK_TELEGRAM_URL` with their
`process.env` defaults, `WEBHOOK_SECRET` guard in `beforeAll`). Do NOT hardcode a
port — mirror `hello.test.ts` exactly so both run identically under `bin/e2e-test`.
Add the mock-anthropic control URL the same way (env with a default). Steps:
1. `POST /test/mode {mode:"rate_limit"}` on the mock, clear mock-telegram
   messages.
2. Post a Telegram text update to the worker (via `buildWebhookUpdate`).
3. Poll (`pollForMessage`) until a `sendMessage` appears; assert its text is
   `RATE_LIMIT_MESSAGE`.
4. `DELETE /test/mode` in `afterEach`/`finally` so other tests are unaffected.

Caveat to note in the test: the worker's in-process AI SDK retries the 429 twice
with exponential backoff (~2s + ~4s) before surfacing, so this test waits a few
seconds longer than `hello.test.ts`. Keep its poll timeout generous (e.g. ≥15s).
Import `RATE_LIMIT_MESSAGE` from the worker source, or inline the exact string,
to avoid drift. Per `docs/e2e-tests.md` this suite runs via `bin/e2e-test` (needs
ZeroVault creds) and is not part of `bin/ci`; run it on demand.

## How to verify

- `gob run bin/ci` — build, lint, typecheck, unit tests (includes the new
  `llm-error.test.ts` and the extended `orchestrator.test.ts`).
- On demand: `bin/e2e-test` for the new mock-429 end-to-end test.

## Skills to use

- `tdd` — write the `llm-error` classifier and orchestrator branch test-first
  (red/green on the small pure function and the catch branch).
- `changelog` — load before editing `CHANGELOG.md`.
- `git-commit` — commit code + test + changelog together (changelog ships in the
  same change per repo AGENTS.md).

## Acceptance criteria

- A 429 or 529 from the interface agent's own `generateText` (the dominant real
  case: an account-wide cap fails the top-level LLM call) results in the user
  receiving `RATE_LIMIT_MESSAGE`, persisted as an assistant message, thread no
  longer awaiting reply, and a `turn_rate_limited` log with status + rate-limit
  headers. A real account-wide 429 hit during research also fails the interface
  agent's own call, so the user still gets `RATE_LIMIT_MESSAGE`. (A 429 thrown
  strictly inside the research tool `execute` is swallowed by the SDK as a
  `tool-error` and is out of scope — see background.)
- Any other thrown error still yields the unchanged `FALLBACK_MESSAGE` +
  `turn_failed`.
- Clean incomplete turns (step cap / empty final text, no throw) still yield the
  unchanged `FALLBACK_MESSAGE`.
- `CHANGELOG.md` has the new top entry.
- `gob run bin/ci` passes.

## Files touched

- `apps/agent-api/src/agents/llm-error.ts` — new classifier + message.
- `apps/agent-api/src/agents/llm-error.test.ts` — new unit tests.
- `apps/agent-api/src/agents/orchestrator.ts` — branch in the `catch`.
- `apps/agent-api/src/agents/orchestrator.test.ts` — new 429 test.
- `packages/agent-e2e/src/mock-anthropic.ts` — 429 mode toggle.
- `packages/agent-e2e/src/rate-limit.test.ts` — new e2e test.
- `CHANGELOG.md` — user-facing entry.
- (optional) `docs/e2e-tests.md` — mention the new rate-limit test + `/test/mode`.
```