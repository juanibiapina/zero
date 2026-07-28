# Retryable-reset: stop turning a DO reset into a user-facing fallback

Status: plan only (no implementation). Scope: the turn-level error boundary in
`apps/agent-api/src/agents/orchestrator.ts`. This is the narrow error-handling
discrimination fix that `docs/plans/do-reset-guidance.md` (research, with
citations) and `docs/plans/agent-latency-investigation.md` (the 2026-07-27
incident) both point at. It is deliberately independent of, and lands before,
the deferred research-checkpoint work in `docs/plans/durable-turns.md` (whose
verify report flags that checkpoint as a weak local optimum given post-fix
research is ~48s, not 10 min). This plan does not checkpoint or resume work; it
stops the orchestrator from sending a spurious fallback for an error the
platform is already going to retry.

## Goal

When a `UserDO` isolate reset ("Durable Object reset because its code was
updated") surfaces inside a turn, the orchestrator must **not** send the user
`FALLBACK_MESSAGE` and must **not** persist a fallback assistant row. It must
rethrow. The platform's at-least-once alarm retry **already** re-runs the turn on
a reset (the `finally { clearBusy }` storage write throws on the dead isolate and
that uncaught throw leaves `alarm()` regardless of what our catch does) — so
rethrowing does not *enable* the retry and is not what delivers the real answer.
The only behavior this change alters is suppressing a premature, now-redundant
fallback message (and never persisting a fallback row); the retry then delivers
the real answer once. Genuine, non-retryable agent failures (LLM refusal,
malformed tool loop, step-cap exhaustion, a plain gateway error) must still hit
the existing fallback path. A reset that defers to retry must be visible in logs
so we never again learn of this only from a user complaint.

Non-goals: resuming or checkpointing in-flight work (deferred, see
`durable-turns.md`); shrinking the reset window at the source (already shipped
via scoped Workers Builds watch paths, see root `AGENTS.md`); changing
persist-before-send.

## Background the reader needs

The runtime stamps a DO reset as a real JS error with untyped properties:
`.retryable === true` and `.durableObjectReset === true`, on a `DISCONNECTED`
exception (confirmed in workerd `src/workerd/jsg/util.c++`; there is no exported
TypeScript type for these — workerd issue #6577 — which is why
`apps/agent-api/src/do/retry.ts` hand-declares a `DOError` interface). Full
citations live in `docs/plans/do-reset-guidance.md`.

DO alarms have documented **at-least-once execution with automatic retry on an
uncaught throw**, exponential backoff from 2s, up to 6 retries
(https://developers.cloudflare.com/durable-objects/api/alarms/). So when an
`alarm()` throws a reset, the platform already re-runs the whole turn for us.
Our own incident logs recorded exactly this: after the 14:24:09 reset the alarm
re-armed and re-ran the entire research loop
(`docs/plans/agent-latency-investigation.md`).

Durable state committed **before** the reset survives; in-memory state is lost.
The reset surfaces at the **first storage syscall on the dying isolate**, and
every subsequent storage op on that isolate also throws. This last fact is
central to the trace below.

## Current-behavior trace (with citations)

### The two catch layers

1. **Turn boundary** — `agents/orchestrator.ts` `runTurn`:
   `markBusy` (line 90) → `try { runInterfaceAgent; runWriterAgent }` →
   `catch (err)` (line 132) → `finally { store.clearBusy }` (line 159). The
   catch (lines 132–158) classifies only rate-limit vs everything-else
   (`isRateLimitError`, line 146), then `await send(reply)` (line 153) and
   `store.storeMessage(conversationId, "assistant", reply)` (line 157). It never
   rethrows. Its comment states the rationale: "an identical retry will not fix
   agent-level failures" — true for a poison agent failure, **false for a
   reset**.
2. **Alarm boundary** — `do/alarm.ts` `runAlarmTurns`: `try { for thread:
   runTurn }` → `catch` logs `alarm_turn_failed`, `await reportError` (ZeroErrors),
   then storage ops (`findThreadsAwaitingReply`, `storage.get/put/setAlarm`) to
   reschedule with a storage-backed backoff counter (`alarmAttempts`). It
   catches and **returns** (never rethrows) so the `setAlarm` write survives the
   output gate. Its header comment already states it cannot catch an isolate
   reset: "A DO isolate reset ... tears down the isolate before catch runs."

The reply path itself is **persist-before-send**: the interface agent's `reply`
tool and final delivery call `persistReply` (which is
`store.storeMessage(...,"assistant",...)`, orchestrator line 87–88) **before**
`send()` (`interface.ts` lines 394–395, 399–400). Behind the DO output gate the
row commits before the Telegram fetch leaves (`docs/topics.md`).

`findThreadsAwaitingReply` (`store/db.ts:302`) selects threads purely on
`tail.role === "user"`; it never reads `busySince`.

### What happens today on each error class

**(a) DO reset** (the incident). Research completes; the interface agent's final
delivery calls `persistReply(answer)` — a SQLite write — which throws the reset
(stack in `agent-latency-investigation.md` Part 2: `Database.insert →
DbStore.storeMessage → persistReply → runInterfaceAgent → runTurn`). Control
enters the orchestrator catch:
   - `isRateLimitError(err)` → false (a reset has no `.status`).
   - `send(FALLBACK_MESSAGE)` → a Telegram `fetch` subrequest, **unaffected by
     the storage-layer reset**, so it goes through. **The user sees the
     fallback.**
   - `store.storeMessage(conversationId,"assistant",FALLBACK_MESSAGE)` → a SQLite
     write on the dying isolate → **throws the reset again**, so the fallback is
     **never persisted**. The thread tail stays `user`.
   - `finally { clearBusy }` → another SQLite write → throws the reset (stack:
     `DbStore.clearBusy → runTurn`, the `alarm_turn_failed` stack in the
     incident). This throw propagates out of `runTurn`.
   - `runAlarmTurns` catch runs `logError`/`reportError` (both fine — console +
     `fetch`), then `findThreadsAwaitingReply()` — a SQLite **read** on the dying
     isolate — throws. The reset propagates out of `alarm()`.
   - Platform: uncaught `alarm()` exception → **automatic at-least-once retry**.
     On a fresh isolate the tail is still `user`, so the turn re-runs from
     scratch and eventually delivers the real answer.

   Net harm today: the user gets a **spurious fallback** on attempt 1, then
   (usually) the **real answer** on the retry — a fallback-then-answer double
   message — plus the full re-run cost. Because the fallback persist throws on
   the dead isolate it does **not** flip the tail: once a reset has surfaced,
   *every* subsequent storage op on that isolate throws, so the fallback
   `storeMessage` can never commit and the tail can never flip to `assistant` on
   the reset path. So the only real harm is the premature fallback double
   message; the "tail flips and suppresses the retry" case cannot occur on a
   reset (it is a theoretical concern for a live isolate only).

   Key consequence to internalize: **on a reset the error propagates out of
   `alarm()` no matter what our catch does**, because the `finally { clearBusy }`
   storage write always throws on the dead isolate. So the platform retry is
   guaranteed already. The only thing our catch changes is whether the user sees
   a premature fallback first.

**(b) Genuine agent failure** (malformed tool loop, model refusal, an
`interface.ts` re-raised send failure). The throw is a plain `Error` with no
`.status` and no `.durableObjectReset`. Catch: `isRateLimitError` → false;
`send(FALLBACK_MESSAGE)`; `storeMessage(fallback)` commits (live isolate) → tail
flips to `assistant`; `clearBusy` commits. Correct today: the user is told once,
the thread stops awaiting reply, no retry storm. Must stay this way.

**(c) LLM capacity error** (429/529). `isRateLimitError(err)` → true (walks
`.status` / `.cause`, `llm-error.ts`). Catch sends `RATE_LIMIT_MESSAGE`,
persists it, logs `turn_rate_limited`. Correct today. Must stay this way (a
429/529 carries `.status`, never `.durableObjectReset`, so the new
discrimination will not intercept it).

**(d) Telegram send failure.** The interface agent captures the first `send`
rejection and re-raises it after the tool loop (`interface.ts` lines 273–286,
387). The undelivered reply row was already persisted (persist-before-send), so
the catch sends the fallback and the history keeps both rows — the documented
"partial turn made visible" (`docs/topics.md`). This is a genuine failure, not a
reset (a plain `Error`), so it must keep hitting the fallback path.

## Design

### 1. The discrimination check (type-safe, on an untyped error)

Add one pure helper, co-located with the existing DO-error property typing in
`do/retry.ts` (that file already hand-declares `DOError` precisely because
workerd exports no type — keep all untyped-DO-property knowledge in one place):

```ts
export interface DOError {
  retryable?: boolean;
  overloaded?: boolean;
  durableObjectReset?: boolean; // added
}

const RESET_MESSAGE = "Durable Object reset because its code was updated";

export const isDurableObjectReset = (err: unknown): boolean =>
  err instanceof Error &&
  (( err as Error & DOError).durableObjectReset === true ||
    err.message.includes(RESET_MESSAGE));
```

- Guard `err instanceof Error` first, then read the untyped property through the
  `DOError` cast and compare `=== true` (strict, not truthy).
- **Key on `durableObjectReset`, not `retryable` alone.** `retryable === true` is
  set on *every* `DISCONNECTED` exception (per workerd source), which includes
  plain network disconnections, not just resets. Keying on `durableObjectReset`
  targets exactly the reset the alarm is guaranteed to auto-retry, and avoids
  silently deferring a persistent non-reset disconnection with no user feedback.
- **The message string is the empirically-observed signal**: it is the one our
  own 2026-07-27 incident logs prove reached our catch (via `fmtErr`). The
  `.durableObjectReset` property is the source-documented signal (confirmed in
  workerd `util.c++`, set on reset `DISCONNECTED` exceptions) but was not
  captured in our logs. We match **both** with an OR, so correctness does not
  depend on which fires; neither is strictly "primary".

### 2. What the catch does on a reset

In `orchestrator.ts` `runTurn`, at the very top of `catch (err)` (before the
rate-limit classification), branch:

```ts
if (isDurableObjectReset(err)) {
  log("turn_reset_retrying", { chat_id: chatId, topic_id: topicId,
      clerk_user_id: input.clerkUserId, error: fmtErr(err) });
  throw err; // let the alarm's at-least-once retry re-run the turn
}
```

- **Send nothing, persist nothing, rethrow.** No `FALLBACK_MESSAGE`, no
  `storeMessage`. The reply path is persist-before-send, so nothing about this
  turn's delivery has been committed when the reset lands on the final
  `persistReply`; the tail stays `user` and the retry re-runs cleanly and
  delivers exactly once.
- The `finally { clearBusy }` still runs; on the dead isolate it throws the same
  reset (masking the rethrown one — either way an uncaught reset leaves
  `alarm()`), and in a live-isolate edge case it commits and `clearBusy`
  succeeds. Either way the alarm sees an uncaught exception and retries. The
  explicit `throw` is still required (not relying on `clearBusy` to throw): it
  makes intent clear and is what our unit tests observe with `MemoryStore`
  (whose `clearBusy` does not throw).
- Everything else (rate-limit, plain agent failure, send failure) falls through
  to the unchanged existing code and still gets the fallback.

`log` (not `logError`) with a distinct event name `turn_reset_retrying` keeps
`turn_failed` reserved for genuine agent failures.

### 3. Terminal path after retries are exhausted

Honest accounting of the retry budget:

- The platform retries an alarm up to **6 times** (7 attempts) with backoff from
  2s. On the 7th failure it gives up.
- **`do/alarm.ts`'s `alarmAttempts` counter does NOT track reset retries.** It is
  incremented only inside `runAlarmTurns`' catch on the reschedule path, and on a
  reset that catch itself throws at its first storage read
  (`findThreadsAwaitingReply`) on the dead isolate — before the increment. So the
  existing counter gives us nothing for resets.
- **`alarmInfo.retryCount` is also unreliable for resets:** it resets on
  re-instantiation, and a reset re-instantiates the DO. So neither existing
  signal tells us "we have exhausted reset retries."

Given that, and that a reset requires a deploy landing inside a single DO's
mid-turn window, exhausting the budget needs **~7 separate deploys each landing
inside one turn's ~2–12 min retry lifetime** (2s→64s backoff plus a full turn
re-run per attempt) — far beyond the worst observed burst of 4 deploys in 33 min,
and made rarer still by the already-shipped scoped watch paths and spaced pushes.
It will not happen at any realistic deploy cadence.

**The self-heal that makes no-counter safe:** even if the budget is exhausted, a
silent drop is not a lost turn. The tail stays `user`, so the **next user
message** to that DO re-arms the alarm (`enqueueTurn`, `UserDO/index.ts:98-100`)
and `findThreadsAwaitingReply` re-runs the still-unanswered thread, answering it
alongside the new message (the old question is still in history). The only
residual harm is the narrow case where the user never writes again: they get no
message and are not told to resend. Bounded, and self-recovering on any further
activity.

**Recommended terminal design (minimal, ship now):** do not build a counter.
After the platform's retries are exhausted the turn is silently dropped; the user
can resend, and a fresh enqueue re-arms the alarm anyway (the self-heal above).
This keeps the change to pure error-handling logic with no new durable state. The
residual "silent drop after 7 straight resets" is documented as an accepted,
negligible risk. In
this design there is **no code-level terminal fallback** — the terminal behavior
is the platform's 6-retry cap, which is not something we send a message for
(sending one would require durably knowing we are on the last attempt, which we
do not).

**Optional hardening (only if logs later show repeated resets on one turn):** a
durable per-turn reset-attempt counter, keyed on the tail `userMessageId` and
**incremented at turn start on the fresh isolate** (where storage works — the
existing `alarmAttempts` fails precisely because it increments on the dead
isolate). When the counter crosses a small threshold (e.g. 3), the catch stops
rethrowing and instead sends **and persists** the fallback once (flipping the
tail to `assistant` so retries stop) — a guaranteed terminal message. This is
unit-testable by injecting the attempt count. It overlaps the deferred
`durable-turns.md` turn-identity work, so it is out of scope unless evidence
demands it. The plan's default is the minimal design.

### 4. No duplicate, never stuck forever

- **No duplicate.** Persist-before-send means the final answer's `persistReply`
  is the write the reset kills, so nothing was committed or sent for this turn;
  the tail stays `user`; the retry delivers exactly once. Rethrowing (vs
  persisting a fallback) removes a row we would otherwise have written, so it
  strictly reduces the chance of a stray assistant row. It cannot create a
  duplicate.
- **Never stuck forever.** Two independent resumption sources: the platform's
  at-least-once alarm retry, and the next user message re-arming the alarm via
  `enqueueTurn`. A thread whose tail is `user` is always eligible for
  `findThreadsAwaitingReply`.
- **Unchanged residual (pre-existing).** If a reset lands *between two replies
  within one turn* (reply 1 persisted+sent, reply 2's persist throws), the tail
  is already `assistant`, so the retry skips the thread and reply 2 is lost — the
  documented "partial turn" tradeoff in `docs/topics.md`. Our fix does not change
  this; it only removes the spurious fallback that today would follow reply 1.

### 5. Busy flag

- On a reset the `finally { clearBusy }` write throws on the dead isolate, so
  `busySince` is **not** cleared and stays set. This is unchanged by our fix.
- It does not matter: `findThreadsAwaitingReply` (`db.ts:302`) ignores
  `busySince` (confirmed in `agent-latency-investigation.md` finding #4), so a
  stuck `busySince` does **not** block the retry or any other thread. The retry
  runs on a fresh isolate, `markBusy` overwrites the stale value, and a clean
  completion clears it. Busy self-heals; it is never a gate. This still holds.

### 6. Observability

The whole point is to see this in logs instead of from a user.

- **New event `turn_reset_retrying`** (info-level `log`, emitted in the catch
  before rethrow) with `chat_id`, `topic_id`, `clerk_user_id`, and `fmtErr(err)`.
  This marks "a reset hit this turn; deferring to the platform retry, no fallback
  sent." `console.log` is not storage, so it survives the dying isolate.
- **`turn_failed` no longer fires for resets** — after this change it means only
  a genuine agent failure, so grepping it is now clean.
- The **retry's success is already observable**: the next attempt logs
  `turn_started` → `interface_completed` / `writer_completed` and sends the
  reply. To correlate a defer with its eventual delivery, `turn_reset_retrying`
  and the subsequent `turn_started` share `chat_id`/`topic_id`.
- The **raw reset is still reported to ZeroErrors** once, via `runAlarmTurns`'
  `reportError` when the reset propagates out of `runTurn` (the `clearBusy`
  throw). We keep that; the raw reset stays counted. `turn_reset_retrying` is the
  positive "we handled it" signal alongside it.
- A daily count of `turn_reset_retrying` **without** a matching later delivery on
  the same thread would flag a genuinely stuck turn — the alert we would build if
  the optional terminal counter is ever needed.

## Ordered steps

1. **Add the classifier.** In `do/retry.ts`, extend `DOError` with
   `durableObjectReset?: boolean` and export `isDurableObjectReset(err: unknown):
   boolean` as specified above (property-primary, message-string fallback).
2. **Branch the orchestrator catch.** In `agents/orchestrator.ts` `runTurn`, at
   the top of `catch (err)`, call `isDurableObjectReset(err)`; on true, `log`
   `turn_reset_retrying` and `throw err`. Leave the existing rate-limit /
   fallback / persist code untouched for all other errors. Import the helper from
   `../do/retry`.
3. **Tests** (below).
4. **Docs.** Update `docs/topics.md` (the "orchestrator is the turn's error
   boundary" paragraph and the "Execution (DO alarm)" reset note) to state that a
   DO reset is now rethrown to the platform's at-least-once retry rather than
   turned into a fallback, and that `turn_failed` now means only a genuine agent
   failure. No `apps/agent-api/CHANGELOG.md` entry is required unless we judge
   "you no longer get a spurious 'try again' when Zero is interrupted and it now
   just finishes on its own" a user-observable improvement — it is, so add a
   one-line user-facing bullet: `- YYYY-MM-DD: If Zero is interrupted while
   answering, it now quietly finishes your answer instead of asking you to try
   again.`
5. **No new binding, no migration** (minimal design). All changes live in
   `apps/agent-api` (`do/retry.ts`, `agents/orchestrator.ts`, docs).

## Test strategy

Pure error-handling logic, unit-testable on this box with `MemoryStore` + a
scripted/throwing model, following the existing `agents/orchestrator.test.ts`
style (`capturingModel(() => { throw ... })`, log spies via
`vi.spyOn(console, ...)`, `findThreadsAwaitingReply` assertions).

1. **Reset rethrows, persists nothing, sends nothing.** Model throws
   `Object.assign(new Error("Durable Object reset because its code was
   updated."), { durableObjectReset: true, retryable: true })`. Assert:
   - `await expect(runTurn(...)).rejects.toThrow(/reset/)` (it rethrows).
   - `sink.sent` is `[]` (no fallback sent).
   - history is `[{role:"user", content:"hi"}]` only (no fallback persisted).
   - a `turn_reset_retrying` log fired; `turn_failed` did **not**.
   - `findThreadsAwaitingReply()` still returns the thread (tail stays `user`),
     proving the retry would re-run it.
   (With `MemoryStore`, `clearBusy` does not throw, so the rethrown reset
   propagates cleanly — exactly what we assert.)
2. **Reset detected via message string only** (no property). Throw a bare
   `new Error("... Durable Object reset because its code was updated ...")` with
   no `durableObjectReset` field; assert the same rethrow/no-send/no-persist
   behavior — pins the string fallback in the classifier.
3. **Plain agent failure still sends and persists the fallback.** Keep the
   existing "delivers a fallback, persists it, clears busy, logs turn_failed"
   test green: a plain `Error("gateway down")` (no `durableObjectReset`, no
   `.status`) must send `FALLBACK_MESSAGE`, persist it, and **not** rethrow.
4. **429 still routes to the rate-limit message.** Keep the existing
   `turn_rate_limited` test green: an error with `{ status: 429 }` and no
   `durableObjectReset` sends `RATE_LIMIT_MESSAGE`, not deferral — proves the
   discrimination does not swallow capacity errors.
5. **Classifier unit tests** in a small `do/retry.test.ts` addition (or a new
   `isDurableObjectReset` block): `durableObjectReset === true` → true; message
   string → true; a plain `Error` → false; a `{ retryable: true }` **without**
   `durableObjectReset` → false (we do not defer plain disconnections); a
   non-Error value (string/undefined) → false.
6. **Retry-exhausted / terminal path.** Under the **minimal** design there is no
   code-level terminal path to unit-test — the terminal behavior is the
   platform's 6-retry cap, which is not on-box observable. State this honestly in
   the test file comment. **Only if** the optional durable counter is adopted:
   inject an attempt count at/over the threshold and assert the catch sends **and
   persists** the fallback once (tail flips to `assistant`,
   `findThreadsAwaitingReply()` empty) instead of rethrowing — the guaranteed
   terminal message.

## Production verification (honest)

- **Deterministic, on-box proof: the unit tests above.** They fully cover the
  discrimination and the rethrow/no-send/no-persist behavior. This is the only
  clean, repeatable proof, because a real reset needs `workerd` plus a live
  version rollout on the target DO, and this box cannot run `workerd` (root
  `AGENTS.md`).
- **Staged deploy-during-turn (optional, production-affecting, racy).** On a test
  chat/user DO: start `wrangler tail` on `zero-api`, send a prompt that triggers
  a ~1–2 min research loop, then `gob run bin/deploy` during that window. Confirm
  from logs and the chat: a "Durable Object reset" event, a `turn_reset_retrying`
  log on attempt 1 with **no** `FALLBACK_MESSAGE` sent, then a fresh
  `turn_started` and exactly **one** substantive answer to the chat, **zero**
  fallback messages. This is only a confidence check: a deploy resets **every**
  `UserDO` on that version (it cannot be scoped to one test DO), and gradual
  rollout makes it nondeterministic which DO flips, so landing the reset in the
  target window is a best-effort race (same limitation `durable-turns-verify.md`
  C3 documents). Do not gate on it.
- **The honest primary production proof is observing the next natural
  occurrence.** Resets happen on essentially every deploy; a mid-turn one is
  rarer but will occur. After this ships, the first natural mid-turn reset shows
  `turn_reset_retrying` (attempt 1, no fallback) followed by a successful
  delivery on the same thread and the absence of `FALLBACK_MESSAGE` /
  `turn_failed` for it. That log signature is the acceptance evidence in
  production; it will populate on its own within a few deploys.

## Acceptance criteria (objectively checkable)

1. `isDurableObjectReset` returns true for an error with `durableObjectReset ===
   true` and for one whose message contains the canonical reset string, and false
   for a plain `Error`, a `{ retryable: true }`-only error, and a non-Error value
   (unit-asserted).
2. On a reset error, `runTurn` **rethrows**, sends nothing, and persists nothing;
   the thread tail stays `user` (unit-asserted; `sink.sent === []`, history has
   only the user row, `findThreadsAwaitingReply` still returns the thread).
3. A `turn_reset_retrying` log event fires on the reset path and `turn_failed`
   does **not** (unit-asserted via log spy).
4. A plain agent failure still sends and persists `FALLBACK_MESSAGE` without
   rethrowing, and a 429/529 still sends `RATE_LIMIT_MESSAGE` (existing tests
   stay green).
5. No new duplicate path: persist-before-send is unchanged; the reset path
   commits no assistant row (follows from criterion 2).
6. `docs/topics.md` describes the reset-rethrow behavior and the new meaning of
   `turn_failed`; a user-facing `CHANGELOG.md` bullet is added.
7. Production log signature confirmed on the next natural mid-turn reset:
   `turn_reset_retrying` on attempt 1 with no fallback sent, followed by a
   successful delivery on the same thread (observational, not a pre-merge gate).

## Risks, dependencies, mitigations

- **Over-narrow classifier misses a reset variant.** Mitigated by the
  message-string fallback OR-ed with the property; if workerd ever renames the
  property, the string still matches. If both ever miss, behavior degrades to
  today's (a fallback is sent) — no regression, just the current bug.
- **Over-broad classifier swallows a real failure.** Mitigated by keying on
  `durableObjectReset` (not bare `retryable`) and `=== true` strictness, so a
  429 (`.status`, no reset flag) and a plain agent error are untouched. Tests 3–5
  pin this.
- **Silent drop after 7 consecutive resets** (minimal design has no terminal
  message). Accepted as negligible (requires 7 deploys each landing in one DO's
  mid-turn window). The optional durable counter is the documented escape hatch
  if logs ever show it.
- **In-flight work still re-runs on the retry** (this plan does not checkpoint).
  Accepted; post-fix research is ~48s (`agent-latency-investigation.md` post-fix
  measurement), so a redo is cheap. The research checkpoint is the separate,
  deferred `durable-turns.md` decision.
- **Dependency:** entirely within `apps/agent-api` (`do/retry.ts`,
  `agents/orchestrator.ts`, tests, docs). No cross-worker change, no binding, no
  migration.

## Skills to use during implementation

- `code` — turning these steps into the classifier and the catch branch.
- `tdd` — the classifier and orchestrator catch are a clean red-green loop.
- `testing` — deciding what to assert at the orchestrator seam without a real DO.
- `changelog` — the user-facing `CHANGELOG.md` bullet.
- `reproducible-locally` — framing the honest "unit tests + observe next natural
  reset" verification.
- `git-commit` — committing code, tests, docs, and changelog together.
