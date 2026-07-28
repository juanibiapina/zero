# Verify report — `retryable-reset.md`

Adversarial verification of `docs/plans/retryable-reset.md` (detect a DO reset on
the caught error and rethrow from `orchestrator.ts` `runTurn`'s catch instead of
sending/persisting `FALLBACK_MESSAGE`, letting the alarm's automatic retry re-run
the turn; no retry counter). Evidence is source, incident logs, and workerd.

## Verdict

**Approve with concerns. No blockers.** The plan is technically sound: the
classifier is robust because it ORs the property and the message string, the
tests are valid and run without `workerd`, and the design is minimal and correct.
The problems are honesty-of-framing, not correctness:

1. The **Goal overstates** what rethrowing buys. The platform retry was already
   guaranteed (the plan's own trace admits this); the only real-world change is
   suppressing a premature, now-redundant fallback. Say that plainly.
2. The "**prevents the fallback persist from flipping the tail and suppressing
   the retry**" benefit is essentially impossible in practice (a dead isolate
   can't commit the fallback persist), so the plan should stop leaning on it.
3. The **no-counter decision omits its strongest justification**: a silent drop
   self-heals on the next user message. Add that fact; it is what makes
   no-counter acceptable.
4. Only the **message string is empirically proven** to reach our catch; the
   `.durableObjectReset` property is source-supported but unconfirmed in our
   runtime. The OR makes this moot, but the plan's "property is primary" framing
   should be softened.

---

## Settled answers to the six questions

### 1. What Maria actually received — the corrected narrative is CORRECT

The plan's trace (a) matches `agent-latency-investigation.md` Part 2 ("Corrects
Round 1") exactly, and the code confirms the mechanics:

- The reset surfaced at `persistReply` (a SQLite write) while the interface
  agent delivered its final research answer, so the **real answer was never
  persisted or sent** (persist-before-send: `interface.ts:394-400`).
- `orchestrator.ts` catch ran: `send(FALLBACK_MESSAGE)` is a Telegram `fetch`,
  **unaffected by the storage reset**, so it went through — **Maria saw the
  fallback**. Then `store.storeMessage(...FALLBACK)` (`orchestrator.ts:157`) is a
  SQLite write on the dead isolate → **threw** → the fallback was **never
  persisted** → the thread tail stayed `user`.
- Tail stayed `user` → `findThreadsAwaitingReply` (`db.ts:302`, selects on
  `tail.role === "user"`) still returned the thread → the platform's alarm retry
  re-ran the turn.

So: **Maria got the fallback AND (eventually) her real answer**, not "just the
fallback." Incident evidence actually shows **two** `turn_failed`/fallback sends
(14:24:09 and 14:36:57, both on chat `6711171416`) because a second deploy reset
the retry too, and the ~15-min reply landed after the retries drained.

The apparent contradiction with `do-reset-guidance.md` is reconciled: that doc
describes the **theoretical** suppression risk ("persisting the fallback flips
the tail, which suppresses the retry's real answer"). In the **actual** incident
the fallback persist **threw**, so the tail never flipped and the answer was not
suppressed. Both are true of their respective cases; the plan states this
correctly ("does not actually flip the tail in this exact sub-case").

**What the fix buys, stated honestly:** it removes the confusing premature
fallback (and the fallback-then-answer double message), so the user just waits
and gets the answer once. It does **not** "unblock a suppressed answer" — nothing
was suppressed in the real incident.

### 2. Is the discrimination property observable in practice?

**Property name confirmed in workerd source.**
`src/workerd/jsg/util.c++` (fetched from `main`):

- L152-157 `setDurableObjectResetError` sets the own JS property
  `durableObjectReset` = `true` via `obj->Set(...)`.
- L138-143 `setRetryableError` sets `retryable` = `true`.
- L216 `setRetryableError` is called for **every** `DISCONNECTED` exception; L221
  additionally calls `setDurableObjectResetError` **only** when
  `result.isDurableObjectReset`.

So the property name in the plan (`durableObjectReset === true`) is exact, and it
is a real own property on the decoded JS error — readable from a Worker catch
block **in principle**.

**But the only signal our own incident logs prove reached us is the message
string.** The incident recorded the error via `fmtErr`, which logged
`"Durable Object reset because its code was updated."` We have **no captured
evidence** that the `.durableObjectReset` JS property was present on the caught
error in our runtime (a storage-syscall error on a torn-down isolate). The
workerd path that stamps the property is the tunneled-exception decode, and the
storage error is a tunneled `DISCONNECTED`, so the property is very likely
present — but that is source inference, not observed fact here.

**Consequence:** the classifier's `property === true || message.includes(...)` is
the right design, but the plan's "the property is primary; the message-string OR
is defensive belt-and-suspenders" is backwards on *evidence*: the **string** is
the empirically-proven path, the **property** is the source-supported one.
Correctness does not depend on which fires (they OR), so this is a wording fix,
not a redesign.

**Bare `retryable` on every DISCONNECTED — CONFIRMED** (util.c++:216). Plain
network drops are `DISCONNECTED` → `retryable = true` but **not**
`durableObjectReset`. So keying on `durableObjectReset` (not bare `retryable`) to
avoid deferring plain disconnections is justified by source.

### 3. Does rethrowing actually change anything? — YES, but only one thing

**Confirmed: the platform retry was already guaranteed regardless of the catch.**
On a reset the isolate is dead, so `finally { clearBusy }` (`orchestrator.ts:159`)
is a SQLite write that throws on the dead isolate; that throw propagates out of
`runTurn` → `runAlarmTurns` catch → `findThreadsAwaitingReply()` (storage read)
throws → propagates out of `alarm()` → automatic at-least-once retry. This holds
today, before the fix. So **the only behavior change is suppressing the premature
fallback `send`.**

**The suppression-prevention benefit is essentially impossible in practice.** The
research establishes that once a reset surfaces, **every** subsequent storage op
on that isolate throws. We only enter the catch *because* a storage op
(`persistReply`) threw the reset, so the isolate is already dead, so the fallback
`storeMessage` can **never commit** on it — the tail can **never flip** to
`assistant` on the reset path. The "differently-timed reset where the fallback
persist commits before a later syscall reset" the plan hypothesizes cannot occur:
there is no "before the reset" once the reset has surfaced. So the honest value
of the fix is **purely** removing the premature fallback double-message.

The **Goal** wording ("It must rethrow so the platform's automatic alarm retry
re-runs the turn cleanly and delivers the real answer") reads as if the rethrow
*enables* the retry. It does not. Recommend the Goal state: the retry already
happens; this change only stops a premature, now-redundant fallback message (and
never persists a fallback row). The plan's own "Key consequence to internalize"
paragraph already says this — promote it into the Goal.

### 4. No-counter decision — SHIP IT, but fix the reasoning

**Recommendation: ship the minimal no-counter design.** It is acceptable, but not
for the reason the plan gives, and the plan omits the fact that makes it safe.

- **"Astronomically unlikely" overstates it.** Exhausting the budget needs ~7
  **separate** deploys each landing within one turn's retry lifetime. A gradual
  rollout resets a given DO at most once per deploy, and the retry backoff is
  2/4/8/16/32/64s **plus** a full turn re-run each attempt (~88s for a research
  turn post-fix, a few seconds for a simple turn). So the 7-attempt window is
  ~2 min (simple) to ~10-12 min (research). The worst observed burst was **4
  deploys in 33 min** — nowhere near 7 in ~10 min. Accurate phrasing: "will not
  happen at any realistic deploy cadence," not "astronomically unlikely."
- **The real safety net the plan omits: a silent drop self-heals.** On exhaustion
  the tail stays `user`, so the **next user message to that DO** re-arms the alarm
  (`enqueueTurn`, `UserDO/index.ts:98-100`) and `findThreadsAwaitingReply` re-runs
  the still-unanswered thread. The dropped turn is not lost; it resumes on the
  user's next message (answered together with it, since the old question is still
  in history). This is the strongest argument for no-counter and the plan should
  state it.
- **Residual harm, honestly:** if the user never writes again, they get **no
  message at all** and are not told to resend — strictly worse than a fallback in
  that one case. It is bounded and self-recovering on any further activity.

Two asks, both cheap:
1. Add the self-heal fact and correct the probability framing.
2. **Actually build** the `turn_reset_retrying`-without-later-delivery alert as
   part of this change, not as a hypothetical ("the alert we would build"). It is
   the only way we would learn the accepted risk materialized.

### 5. Duplicate risk — CONFIRMED none, in fact fewer messages

persist-before-send is unchanged (`interface.ts:394-400`, `orchestrator.ts:87`).
On a reset the fix persists nothing and sends nothing, the tail stays `user`, and
the retry delivers exactly once. The fix **strictly reduces** messages: today the
fallback is sent and then the retry also delivers the real answer (a
double-message); the fix removes the fallback. The pre-existing "partial turn"
case (a reset landing between two replies *within one turn*, first reply already
persisted+sent) is unchanged — the plan says so.

### 6. Tests — CONFIRMED genuine and workerd-free

`orchestrator.test.ts` already uses `MemoryStore` + scripted/`capturingModel`
models with no `workerd`, exactly the style the plan's tests follow. Verified
`MemoryStore.clearBusy` (`memory.ts:247`) is a plain map write that does **not**
throw, so a reset thrown from the model propagates through the `finally` cleanly
and `await expect(runTurn(...)).rejects.toThrow(/reset/)` holds, `sink.sent` is
`[]`, and history keeps only the user row. The proposed tests genuinely cover
rethrow / no-send / no-persist / tail-stays-`user` / `turn_reset_retrying` fired /
`turn_failed` not fired, plus the classifier units and the still-green
fallback/429 tests.

**Acknowledged gap (the plan owns it):** the unit tests cannot exercise the real
dead-isolate behavior where `clearBusy` *also* throws — which is exactly why the
explicit `throw err` is required rather than relying on `clearBusy` to throw. The
plan states this correctly.

### 7. Acceptance criteria — objectively checkable

Criteria 1-6 are unit-assertable on this box. Criterion 7 (production log
signature on the next natural mid-turn reset) is observational and honestly
flagged as "not a pre-merge gate." Given that honest admission, the criteria are
objectively checkable.

---

## Ranked findings

### Blockers

None.

### Concerns

**C1 — Goal overstates the change; the only real effect is suppressing the
premature fallback.** The platform retry is already guaranteed by the
`finally { clearBusy }` throw on the dead isolate (verified against
`orchestrator.ts:159` + the incident's `alarm_turn_failed` `clearBusy` stack).
Rethrowing does not enable the retry. **Fix:** reword the Goal to "the retry
already re-runs the turn; this change stops the orchestrator from sending/
persisting a premature, now-redundant fallback for it," and drop any implication
that rethrow is what delivers the real answer.

**C2 — the "fallback persist would flip the tail and suppress the retry" benefit
is impossible in practice.** Once a reset surfaces, every subsequent storage op on
that isolate throws, so the fallback `storeMessage` can never commit and the tail
can never flip on the reset path. **Fix:** remove the "differently-timed reset …
would flip the tail" hedge as a claimed benefit; keep only the honest value
(no premature fallback). Correctness is unaffected either way.

**C3 — no-counter reasoning is missing its best argument and overstates the
odds.** **Fix:** (a) state that a silent drop self-heals — the tail stays `user`
so the next user message re-arms the alarm (`UserDO/index.ts:98-100`) and re-runs
the thread; (b) replace "astronomically unlikely" with the accurate "needs ~7
separate deploys inside one turn's ~2-12 min retry lifetime, far beyond the
observed 4-in-33-min burst"; (c) commit to building the
`turn_reset_retrying`-without-delivery alert in this change, not hypothetically.
Recommendation stands: **ship no-counter.**

**C4 — "property is primary, string is defensive" inverts the evidence.** Source
confirms the `durableObjectReset` property (util.c++:152-157) and that it is set
on reset `DISCONNECTED` exceptions (L221), but our incident logs only prove the
**message string** reached our catch. **Fix:** keep the OR (robust regardless);
soften the wording to "the message string is the empirically-observed signal in
our own incident; the property is the source-documented signal — we match both."

### Nits

**N1 — RESET_MESSAGE omits the trailing period** the incident logged
("… updated**.**"). Harmless because the classifier uses `.includes()`; leave as
is or note it.

**N2 — the classifier's `err instanceof Error` guard** correctly makes a bare
string/undefined return `false` (asserted in the plan's test 5). Good; no change.

**N3 — observability wording:** `turn_reset_retrying` is logged before the
rethrow via `console.log` (not storage), so it survives the dying isolate — the
plan's claim checks out. The raw reset is still reported to ZeroErrors via
`runAlarmTurns`' `reportError` when the reset propagates out (verified against
`alarm.ts:64`). No change needed.

---

## Bottom line

The plan is safe to implement as written; none of the concerns block it. Before
building, tighten four sentences: the Goal (C1), the suppression benefit (C2), the
no-counter justification (C3), and the property-vs-string framing (C4). The
classifier, the rethrow, the test plan, and the no-counter decision are all
sound. **Ship the minimal no-counter design**, add the self-heal note, and build
the `turn_reset_retrying`-without-delivery alert as part of this change.
