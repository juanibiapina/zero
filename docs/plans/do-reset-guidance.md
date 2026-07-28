# "Durable Object reset because its code was updated": Cloudflare's documented contract vs. our code

Research deliverable. Answers the six questions with citations, then reads our
alarm/orchestrator path against that guidance. Findings only, no code changes.

Sources are quoted verbatim. Primary sources:

- DO Error handling (best practices): https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
- DO Troubleshooting (observability): https://developers.cloudflare.com/durable-objects/observability/troubleshooting/
- DO Alarms (API): https://developers.cloudflare.com/durable-objects/api/alarms/
- DO Known issues (platform): https://developers.cloudflare.com/durable-objects/platform/known-issues/
- workerd source `src/workerd/jsg/util.c++` (the runtime that stamps `.retryable`): https://github.com/cloudflare/workerd/blob/main/src/workerd/jsg/util.c++
- workerd issue #6577 (no exported TS type for these props): https://github.com/cloudflare/workerd/issues/6577
- Community/Discord corroboration (dabblewriter durable-apis retry list; "known issues" LLM-call thread): https://www.answeroverflow.com/m/1227713034890383482 , https://community.cloudflare.com/t/how-to-handle-the-error-about-do-code-being-updated/703770

---

## TL;DR

- The reset error **is retryable**. The runtime marks it so: it is a
  `DISCONNECTED` exception, and workerd stamps every `DISCONNECTED` exception
  with `.retryable = true` (plus a `.durableObjectReset = true` tag). Confirmed
  in workerd source, not inferred.
- **`.retryable` is an application contract, not automatic runtime retry** for
  the general call. The runtime does not transparently re-drive an arbitrary
  DO stub call for you. Cloudflare's docs say the *application* should catch and
  retry with exponential backoff, and only if the request is idempotent.
- **Alarms are the one exception**: an `alarm()` that throws an uncaught
  exception **is retried automatically** by the platform, at-least-once,
  exponential backoff from 2s, up to 6 retries. So the platform *did* retry our
  turn for us. Our own investigation logs (`docs/plans/agent-latency-investigation.md`)
  confirm the alarm re-fired and re-ran the whole turn.
- Durable storage already committed before the reset **survives**; in-memory
  state is gone. There is no partial-write hazard from the reset itself: the DO
  output gate makes each `storage` write atomic and confirmed-before-visible.
- **Where we fight the platform:** in `orchestrator.ts` we catch the thrown
  error at the turn boundary, send the user `FALLBACK_MESSAGE`, and persist it
  as the assistant reply. When the thrown error is a reset, this is the wrong
  move: the alarm is *already going to re-run the turn*, so we (a) tell the user
  "something went wrong, try again" when the platform is about to answer them
  anyway, and (b) persist a fallback assistant row that flips the thread tail to
  `assistant`, which is exactly the signal our retry path uses to *skip* the
  thread — so the fallback can suppress the good answer the retry would produce.
  We treat a retryable transient exactly like a poison agent failure.

---

## 1. The error's retryability contract

**Is the reset marked retryable? Yes — by the runtime, unconditionally, because
it is a disconnection.**

Direct source evidence from workerd, which is the runtime that adds the
`.retryable` property. In `src/workerd/jsg/util.c++`, the decode path for a
tunneled exception:

```cpp
if (exception.getType() == kj::Exception::Type::DISCONNECTED) {
    result.isDisconnection = true;
    result.handle = v8::Exception::Error(v8StrIntern(isolate, "Network connection lost."_kj));
    ...
    // DISCONNECTED exceptions are considered retryable
    setRetryableError(isolate, result.handle);

    if (tunneledInfo.isDurableObjectReset) {
      setDurableObjectResetError(isolate, result.handle);
    }
}
```

and `setRetryableError` sets the JS property literally:

```cpp
bool setRetryableError(v8::Isolate* isolate, v8::Local<v8::Value>& exception) {
  ...
  obj->Set(context, v8StrIntern(isolate, "retryable"_kj), v8::True(isolate));
}
```

So a DO reset arrives as a `DISCONNECTED` exception carrying `retryable === true`
and additionally `durableObjectReset === true`. (There is no exported TypeScript
type for these yet — see workerd issue #6577 — which is why our `do/retry.ts`
hand-declares a `DOError` interface.)

**What `retryable` means: the application is expected to retry; the runtime does
not silently retry the general call.** Error-handling doc, verbatim:

> Any uncaught exceptions thrown by a Durable Object or thrown by Durable
> Objects' infrastructure (such as overloads or network errors) will be
> propagated to the callsite of the client. Catching these exceptions allows you
> to retry creating the `DurableObjectStub` and sending requests.

> JavaScript Errors with the property `.retryable` set to True are suggested to
> be retried if requests to the Durable Object are idempotent, or can be applied
> multiple times without changing the response. If requests are not idempotent,
> then you will need to decide what is best for your application. It is strongly
> recommended to apply exponential backoff when retrying requests.

Troubleshooting doc corroborates for the stub-creation case:

> Those lookups are usually cached, meaning attempts for the same set of recently
> accessed Durable Objects should be successful, so catching this error and
> retrying after a short wait is safe.

Community corroboration (a widely-used retry list treats this exact string as
retryable): dabblewriter/durable-apis matches
`'Durable Object reset because its code was updated'` and
`'The Durable Object's code has been updated'` alongside `'Network connection
lost'`, commenting "Usually 1 retry is all that is needed."

## 2. Automatic retry behavior for a DO stub call (fetch / RPC)

**The runtime does not transparently retry an arbitrary in-flight stub call.**
The documented model is: the exception is *propagated to the client callsite*,
and the client is expected to catch it, make a **fresh stub**, and re-send. The
canonical example in the error-handling doc is a hand-written loop:

```ts
let maxAttempts = 3, baseBackoffMs = 100, maxBackoffMs = 20000, attempt = 0;
while (true) {
  try {
    // Create a Durable Object stub for each attempt, because certain types of
    // errors will break the Durable Object stub.
    const doStub = env.ErrorThrowingObject.getByName(userId);
    const resp = await doStub.fetch("http://your-do/");
    return Response.json(resp);
  } catch (e: any) {
    if (!e.retryable) break;          // don't retry non-transient
  }
  // exponential backoff, cap attempts...
}
```

Conditions and limits the docs state or imply:

- **Idempotency is the caller's responsibility.** Retry only "if requests to the
  Durable Object are idempotent … If requests are not idempotent, then you will
  need to decide what is best for your application."
- **A retryable error breaks the stub.** You must fetch a **new** stub between
  attempts ("certain types of errors will break the Durable Object stub").
- **`.overloaded` is the opposite signal — never retry:** "JavaScript Errors
  with the property `.overloaded` set to True should not be retried. If a Durable
  Object is overloaded, then retrying will worsen the overload."
- The docs do not distinguish RPC vs `fetch()` here; both surface the same
  `.retryable`/`.overloaded`-tagged exception to the callsite. Request-body
  consumption is not addressed in the docs; the safe reading is that a
  half-consumed body is one more reason the call is not automatically re-drivable
  and why a fresh stub + fresh request is required.

This is exactly what our `do/retry.ts` `withDORetry` implements, and it is used
for the **webhook → DO** hop (`UserDO/stub.ts`). That part matches the guidance.

## 3. Alarms specifically — the platform DID retry our turn

Our turn runs inside `alarm()`. Alarms have their own, stronger contract. Alarms
API doc, verbatim:

> Alarms have guaranteed at-least-once execution and are retried automatically
> when the `alarm()` handler throws.

> Retries are performed using exponential backoff starting at a 2 second delay
> from the first failure with up to 6 retries allowed.

and on the handler itself:

> The `alarm()` handler has guaranteed at-least-once execution and will be
> retried upon failure using exponential backoff, starting at 2 second delays
> for up to 6 retries. This only applies to the most recent `setAlarm()` call.
> Retries will be performed if the method fails with an uncaught exception.

> `alarmInfo`: `retryCount` (number of retries), `isRetry` (true on a retry).

The known-issues doc describes the reset-and-resume for alarms directly:

> If an unexpected error terminates the Durable Object, the `alarm()` handler may
> be re-instantiated on another machine. Following a short delay, the `alarm()`
> handler will run from the beginning on the other machine.

**Confirming the task's hypothesis: yes, the platform retried the turn for us.**
Our own investigation (`docs/plans/agent-latency-investigation.md`) recorded
exactly this: after a reset at 14:24:09 the alarm "immediately re-armed and
re-ran (`turn_started` 14:24:13 → `research_started` 14:24:18)", i.e. the whole
research loop ran a second time. That second run is the platform's automatic
alarm retry, not our code. Note a subtlety the doc flags: automatic alarm retry
"only applies to the most recent `setAlarm()` call" and `alarmInfo.retryCount`
**resets** on a re-instantiation path — which is why `do/alarm.ts` intentionally
tracks its own `alarmAttempts` counter in storage rather than trusting
`retryCount`.

Caveat on "is the alarm still set": the retry semantics apply to the most recent
`setAlarm()`. `deleteAlarm()` inside the handler "may prevent retries on a
best-effort basis, but is not guaranteed." We do not call `deleteAlarm()`, and
our enqueue path re-arms an alarm on the next user message regardless, so we have
two independent resumption sources (platform alarm retry + next-message re-arm).

## 4. The recommended application pattern

Cloudflare's guidance for transient/reset errors is consistent across pages:
**catch, make a fresh stub, retry with exponential backoff, but only if the
operation is idempotent.** Verbatim (error-handling):

> Catching these exceptions allows you to retry creating the `DurableObjectStub`
> and sending requests. … suggested to be retried if requests … are idempotent …
> It is strongly recommended to apply exponential backoff when retrying requests.

For **long-running work that must survive a code update**, the docs are honest
that there is no in-DO magic:

- The known-issues doc states resets are expected and gives the design rule:
  "A Durable Object may be replaced in the event of a network partition or a
  software update (including either an update of the Durable Object's class code,
  or of the Workers system itself). … it is best practice to ensure that API
  changes between your Workers and Durable Objects are forward and backward
  compatible across code updates." That protects the **wire contract** across a
  rollout; it does nothing to rescue an in-flight isolate.
- A Cloudflare-staff "known issues" community thread about LLM calls inside a DO
  states the blunt truth: "If the object resets, this LLM provider call is
  interrupted, and there isn't really a way to gracefully retry (apart from
  reperforming the LLM request itself)." I.e. mid-flight in-memory work
  (including an in-flight generation) is lost and must be re-done; the platform
  gives you at-least-once re-execution, not exactly-once resumption.
- The documented durable-execution primitive for multi-step work that must
  survive resets/redeploys is **Workflows** (each `step.do` return value is
  persisted and successful steps don't re-run). This is the platform's intended
  home for "long-running multi-step job" — see the repo's own analysis in
  `docs/plans/durable-turns.md`. A DO alarm gives at-least-once *whole-handler*
  retry; Workflows give *per-step* checkpointed retry.

So the recommended pattern for our case is: **make the alarm handler idempotent
and checkpoint progress to storage**, so the platform's automatic alarm retry
resumes cheaply instead of re-running everything, OR move the multi-step turn
into Workflows for real per-step durability. `blockConcurrencyWhile` is the tool
for **initialization/critical sections within a live isolate** (we already use it
for migrations in the constructor); it is not a reset-survival mechanism.

## 5. Storage transaction semantics on reset

**Durable state already persisted survives; in-memory state is lost; there is no
"half-written row" hazard from the reset itself.** Troubleshooting doc, verbatim:

> Reset in error messages refers to in-memory state. Any durable state that has
> already been successfully persisted via `state.storage` is not affected.

The atomicity guarantee comes from the **output gate**: a storage write is not
made visible (and dependent network output is held) until the write is confirmed.
workerd surfaces the gate failure mode explicitly (`broken.outputGateBroken;
… Durable Object storage operation exceeded …` in `io/worker.c++` and
`api/actor-state.c++`). Practical consequence: a checkpoint you *observe as
committed* can be trusted; a write the reset interrupted simply did not happen
(the await threw), so on the retry you re-derive it. There is no torn/partial
committed row to defend against. This is what makes our persist-before-send
reply contract sound (documented in `docs/topics.md`): the assistant row commits
behind the output gate before the Telegram fetch leaves.

The one thing the output gate does **not** do is save the operation the reset
killed — if the reset lands *on* the persist, that persist is lost and must be
redone by the retry. That is the real gap in our current turn: the final answer
is composed in memory and only persisted at delivery, so a reset before that
persist loses the answer and the retry recomputes it from scratch.

## 6. What the platform intends that we are not using

- **Automatic alarm retry (we ARE getting this, but then defeating it).** The
  platform already re-runs the alarm at-least-once with backoff up to 6 times.
  Our orchestrator's catch-and-fallback converts a resumable transient into a
  terminal user-visible failure (details in the next section). We are half-using
  the mechanism: we let the alarm re-fire, but we also poison the retry by
  writing a fallback assistant row.
- **Checkpointing for cheap resume.** The intended pattern for expensive
  multi-step work under at-least-once retry is to persist intermediate results so
  a retry skips completed steps. We persist replies as they are sent, but the
  research loop and the final answer are not checkpointed, so a reset re-runs the
  entire ~10-min, ~$3 loop. `docs/plans/durable-turns.md` already scopes a
  `turn_cache` for this.
- **Workflows for durable execution.** Not used. The platform's decision tree
  routes "long-running multi-step jobs" to Workflows precisely because DOs give
  whole-handler retry, not per-step resumption.
- **Output gate** — we DO use this correctly (persist-before-send).
- **`.retryable`/`.overloaded` on the stub hop** — we DO use this correctly
  (`withDORetry` in `UserDO/stub.ts`), matching the error-handling example.
- **Input gate / `blockConcurrencyWhile`** — used only for constructor
  migration. Not a reset-survival tool; nothing to change there.

---

## Where our code fights the platform instead of using it

Files: `apps/agent-api/src/UserDO/index.ts` (`alarm`, `runTurn`),
`apps/agent-api/src/do/alarm.ts` (`runAlarmTurns`),
`apps/agent-api/src/agents/orchestrator.ts` (`runTurn` error boundary),
`apps/agent-api/src/do/retry.ts` (`withDORetry`).

### What matches the guidance

1. **Webhook → DO stub retry** (`UserDO/stub.ts` + `do/retry.ts`): fresh stub per
   attempt, retry on `.retryable`, never on `.overloaded`, exponential backoff,
   cap 3. This is a faithful copy of Cloudflare's error-handling example. Good.
2. **Output-gated persist-before-send** for live replies. Matches §5. Good.
3. **`do/alarm.ts` catch-and-reschedule for catchable errors** (LLM gateway,
   network abort) with a storage-backed backoff counter and a
   "only reschedule while work remains" circuit breaker. This is a reasonable
   application-level retry that deliberately avoids the 6-retry cap. It also
   correctly notes it cannot catch an isolate reset (the reset tears down before
   the catch runs). Good, and self-aware.

### Where we diverge — the reset case specifically

The divergence is in `orchestrator.ts` `runTurn`'s `catch`:

```ts
} catch (err) {
  // ... logs turn_failed / turn_rate_limited ...
  const reply = rateLimited ? RATE_LIMIT_MESSAGE : FALLBACK_MESSAGE;
  await send(reply);
  store.storeMessage(conversationId, "assistant", reply);   // <-- flips tail to assistant
}
```

The comment's own rationale is "an identical retry will not fix agent-level
failures" — true for a poison LLM/tool failure, **false for a reset**. Two
distinct error classes are collapsed into one handler:

1. **Agent-level failure** (malformed tool loop, model refusal, step-cap): not
   retryable, telling the user + persisting a fallback is correct (stops a retry
   storm). This is the case the code was written for.
2. **DO reset** (`.retryable === true`, `.durableObjectReset === true`): the
   platform's alarm retry is *already going to re-run this turn*. Sending
   `FALLBACK_MESSAGE` here tells the user "try again" for something the platform
   is about to answer, and persisting the fallback as `assistant` **flips the
   thread tail**, which is the exact signal `findThreadsAwaitingReply()` /
   `runTurn` use to decide a thread is answered and skip it. So our fallback can
   pre-empt and suppress the correct answer the automatic retry would deliver —
   or produce a fallback-then-real-answer double message, depending on timing.

Crucially, per our own investigation the reset most often surfaces at the **first
storage syscall after the isolate is regenerated** — e.g. `persistReply` or the
`finally` `clearBusy` — i.e. *inside* the `try`/`finally`, where this catch (or
the alarm's outer catch) sees it. So the reset error does reach our catch paths
in practice; it is not purely an out-of-band teardown.

**Net:** for the reset class we are doing the opposite of Cloudflare's
guidance. The guidance is "this is retryable, let it be retried (idempotently)."
We instead terminate the turn with a user-facing apology and write a durable
marker that can cancel the platform's own retry.

### Concrete gaps to close (findings, not a plan)

1. **Discriminate the reset from agent failures at the boundary.** The runtime
   gives us the signal for free: `err.durableObjectReset === true` (and/or
   `err.retryable === true`). On that signal, do **not** send `FALLBACK_MESSAGE`
   and do **not** persist a fallback assistant row — rethrow (or otherwise let
   the alarm's at-least-once retry own it) so the turn re-runs cleanly. Reserve
   the fallback for genuinely non-retryable agent failures.
2. **Make the turn idempotent + checkpointed** so the automatic retry is cheap
   and cannot double-answer: persist the final answer behind the output gate
   before/at send (as live replies already are), and checkpoint the research
   result (`turn_cache`, already scoped in `docs/plans/durable-turns.md`) so a
   reset-driven retry resumes instead of re-running the ~10-min loop.
3. **Shrink the reset window at the source** (already identified in
   `agent-latency-investigation.md`): scoped Workers Builds watch paths so
   non-agent pushes don't redeploy `zero-api`, and spacing out pushes. This is
   already partly done (see AGENTS.md build-watch-paths section) and reduces how
   often the reset lands mid-turn, but does not change the correctness argument
   above.
4. **Longer term**, the platform's intended home for this shape of work is
   Workflows (per-step durable execution). The DO would remain the topic store
   and coordination point. Trade-offs already analyzed in
   `docs/plans/durable-turns.md`.
</content>
</invoke>
