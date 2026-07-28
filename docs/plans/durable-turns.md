> **SUPERSEDED 2026-07-27** — superseded by `docs/plans/retryable-reset.md` (the
> shipped fix). Not the current plan; do not implement. The platform already
> retries the reset via alarm auto-retry, so the checkpoint/Workflows machinery
> here is unnecessary, and its research-cache premise rested on pre-speedup cost
> numbers that no longer hold. Kept as a record of the approach not taken.

# Durable turns: survive a deploy or DO reset without redoing completed work

Status: plan only (no implementation). Motivated by the 2026-07-27 incident in
`docs/plans/agent-latency-investigation.md`. Read that first for the ground-truth
evidence; this plan reuses its findings and does not re-derive them.

## Goal

An agent turn must survive a mid-turn `UserDO` isolate reset (deploy or platform
software update) without (a) redoing completed expensive work (LLM calls, web
searches, a finished research loop) and (b) replacing an answer that was already
generated with the "Sorry, I couldn't finish that one" fallback. The fix must
not reintroduce duplicate Telegram messages, and a resume must be observable in
logs so we never again learn of the failure only from a user complaint.

## The failure, restated with the code path

On 2026-07-27 a deploy reset Maria's `UserDO` isolate while her turn was
finalizing. The reset surfaced at the **first SQLite write after the isolate was
regenerated**, which was `persistReply` storing her finished research answer:

```
Error: Durable Object reset because its code was updated.
  at Database.exec / Database.insert
  at DbStore.storeMessage
  at persistReply            (interface.ts final delivery)
  at runInterfaceAgent → runTurn → runAlarmTurns → UserDO.alarm
```

Two harms, distinct:

1. **Delivery lost.** `persistReply` runs *before* `send` (persist-before-send,
   chosen so retries do not duplicate; see `docs/topics.md`). The persist threw,
   so the real answer was never persisted or sent; the turn-level `catch` sent
   `FALLBACK_MESSAGE` over Telegram (a `fetch` subrequest, unaffected by the
   storage-layer reset), so Maria got the fallback instead of her answer.
2. **Work lost.** Because the turn aborted before persisting anything, the alarm
   retry re-ran the **entire ~10-minute, ~$3 research loop from scratch**. The
   generated research result lived only in the isolate's memory and vanished.

The crucial mechanic: at the moment of reset the generated answer *was in
memory* (it was the argument to `persistReply`), but the runtime throws on the
next storage syscall and then discards the isolate, so we cannot commit it. The
only state that survives a reset is what was **already committed to storage
before the reset**.

## Research findings (with citations)

### 1. What Cloudflare actually offers

**A DO reset on deploy is not avoidable, only survivable. This is the single
most important finding.**

- "A Durable Object may be replaced in the event of a network partition or a
  software update (including either an update of the Durable Object's class
  code, or of the Workers system itself)."
  — Durable Objects → Known issues,
  https://developers.cloudflare.com/durable-objects/platform/known-issues/
- "Code changes for Workers and Durable Objects are released globally in an
  eventually consistent manner. Because each Durable Object is globally unique,
  the situation can arise that a request arrives to the latest version of your
  Worker … which then calls to a unique Durable Object running the previous
  version of your code for a short period of time (typically seconds to
  minutes). If you create a gradual deployment, this period … is determined by
  how long your live deployment is configured to use more than one version."
  — same page. Gradual deployments therefore only **shrink the fraction of DOs
  reset per rollout step and stretch the window**; they cannot prevent a
  mid-turn reset for the DO that is mid-turn when its version flips.
- "There are normal operations like code deployments that trigger Durable
  Objects to restart and lose their in-memory state. For these reasons, you
  should use Storage API to persist state durably on disk that needs to survive
  eviction or restart."
  — Durable Objects → Access Durable Objects Storage,
  https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- "Reset in error messages refers to in-memory state. Any durable state that has
  already been successfully persisted via `state.storage` is not affected."
  — Durable Objects → Troubleshooting,
  https://developers.cloudflare.com/durable-objects/observability/troubleshooting/

There is **no graceful drain, no "finish the current alarm" hook, and no
version-pinning that keeps an in-flight isolate alive to completion.** Workers
versions/deployments track code, not DO execution: "State changes for associated
storage resources such as KV, R2, Durable Objects, and D1 are not tracked with
versions."
(https://developers.cloudflare.com/workers/configuration/versions-and-deployments/).
Version affinity routes *new requests* to a matching version; it does not rescue
an isolate that is torn down when its version stops serving.

**What is committed vs lost when a reset hits.** Durable storage committed before
the reset survives (troubleshooting citation above). Everything in memory is
lost: the running agent loop, the accumulated `messages` array, an in-flight LLM
generation, and any result not yet written to SQLite. The DO **output gate**
holds outbound network effects until preceding storage writes are confirmed, so
persist-before-send guarantees the assistant row commits before the Telegram
`fetch` leaves (this is the existing no-duplicate guarantee in `docs/topics.md`);
it does **not** help when the persist itself is the operation the reset kills.
`blockConcurrencyWhile` (used in the constructor for migration) serializes
critical sections within a live isolate but does nothing across a reset.

**Cloudflare Workflows** (durable multi-step execution) is real and relevant:

- Semantics: a class extending `WorkflowEntrypoint`; each `step.do(name, fn)` is
  independently retriable and its **return value is persisted** (the step name is
  the cache key), so "failed steps don't re-run successful ones." `step.sleep` /
  `step.waitForEvent` let an instance wait for up to 365 days without consuming
  resources. Source: https://developers.cloudflare.com/workflows/ and the local
  `cloudflare` skill (`references/workflows/`).
- Limits (paid): **step state ≤ 1 MiB per return**, instance state ≤ 1 GB,
  **≤ 1,024 steps per instance**, step CPU 30s default / 5min max (LLM calls are
  I/O wall-clock, not CPU, so a 165s generation is fine under the **10-min
  per-attempt step timeout**), subrequests 1,000/step, ≤ 10k concurrent running
  instances (waiting/sleeping excluded). Completed instances are retained 30 days
  (paid). Source: https://developers.cloudflare.com/workflows/reference/limits/.
- Composition: a Workflow accesses bindings via `this.env`, so it **can call back
  into a DO** (via the DO binding) and into Telegram/AI Gateway. But a Workflow
  is its **own execution unit, not code running inside the DO**. Moving the turn
  into a Workflow moves the turn's working state out of the DO; the DO would
  remain the topic store and the per-user coordination point, reached by
  cross-boundary calls from Workflow steps.
- Honest caveat that applies to **any** durable-step scheme, Workflows included:
  a step that is *in flight* when the deploy lands still re-runs on resume. A
  half-finished LLM generation cannot resume; only a **completed** step whose
  return was persisted is skipped. Workflows do not make an in-progress
  Anthropic call resumable; they make a *completed* one durable.

### 2. Where the real cost is

Per-turn work, classified by what a reset may safely redo:

| Work unit | Cost if redone | Idempotent to redo? | Safe to store its result? |
|---|---|---|---|
| A completed research loop (~10 min, ~$3, 20+ LLM calls + web searches) | Very high | Yes (read-only tools), but wasteful | **Yes** — read-only, pure text report |
| An in-flight LLM generation | The tokens already spent | Cannot resume; must restart the call | N/A (nothing to store yet) |
| A completed interface LLM step | One model call (~cheap) | Yes | Yes, but low value on a plain turn |
| `reply()` send (Telegram) | A duplicate user-visible message | **No** — external side effect | The row is the idempotency record |
| `create_topic`/`update_topic` writes | A duplicate/again write | Mostly (last-write-wins on body) | Already durable in SQLite |
| Writer consolidation | One writer run | Yes | Already the documented skip-on-retry tradeoff |

The expensive, non-idempotent-to-lose unit is the **completed research result**:
minutes and dollars, produced ~1 minute into a long turn, then held only in
memory until the turn ends. A plain (non-research) answer is cheap to regenerate
(~5s, per the incident's healthy-turn measurement), so losing and redoing it is
tolerable. The `reply()` send is the only unit that must never be redone
blindly, and persist-before-send already governs that.

**Conclusion:** the highest-value durable checkpoint is the research tool's
result. Storing it the instant research returns converts the retry from a 10-min,
$3 redo that ends in a fallback into a seconds-long redo that delivers the real
answer.

## Options compared

### Option A: checkpoint the turn in DO SQLite

Persist turn progress to SQLite between agent steps so a retry resumes from the
last committed step instead of restarting.

- **Full form** (general per-step checkpoint of the interface loop): after each
  `run.ts` step, append the step's delta (the assistant message + tool_result
  blocks) to a `turn_steps` table keyed by turn identity; on resume, replay
  committed steps without calling the model, and only re-enter the loop at the
  first uncommitted step. This is a hand-rolled equivalent of Workflows' step
  memoization.
  - Checkpoint contents: agent phase, the accumulated `messages` array (assistant
    + tool_result blocks), research sub-loop position/result, the `accessed` set.
  - Size: the interface `messages` array reached ~92k tokens (~300-400 KB of
    text) in the incident. Store deltas per step (append-only), not the whole
    array each step, or the write cost is O(n²) bytes. Per-step write is one row;
    cheap against a $0.30 LLM call.
  - Hard part: **side-effect idempotency on replay.** `reply()` sends Telegram
    and `update_topic` writes SQLite; replaying a step must not re-send or
    re-write. Every side-effecting tool needs its own guard. This is the bulk of
    the complexity and risk.
- **Partial form (the cheap 80%)**: checkpoint only the **completed research
  result** (and optionally the final composed answer), keyed by turn identity.
  Research is read-only and returns pure text, so caching and replaying it is
  side-effect-free and trivially correct. On a retry, the `research` tool returns
  the cached report without calling the model or web search; the interface agent
  recomposes and delivers the answer in one cheap step. This removes the
  incident's entire harm (the 10-min redo and the fallback) with a small,
  contained change and **no new duplicate risk** (delivery ordering is
  unchanged).

Pros: stays inside the DO, preserves per-user serialization (the alarm still
drains one thread at a time behind the busy flag), keeps the topic store local,
minimal new infrastructure. The partial form is a few files.
Cons: the full form re-implements step memoization and its idempotency guards by
hand; easy to get subtly wrong.

### Option B: run the turn as a Cloudflare Workflow

Model each agent step / LLM call as a `step.do`. Durable step outputs mean a
deploy resumes from the last committed step.

Pros: durability is the platform's job; retries and backoff are built in; a
completed step never re-runs; sleeping instances are free (useful if research
ever goes fully async).
Cons, honestly weighed:
- **Per-user serialization moves out of the DO.** The DO gives us single-threaded
  per-user execution (alarm drains threads in order, `busySince`,
  `findThreadsAwaitingReply`). A Workflow instance per turn does not serialize
  per user; we would key instances per user and reject concurrent instances to
  re-create what the DO already gives for free.
- **State leaves the DO but the source of truth does not.** Topics live in DO
  SQLite; every `get_topic`/`update_topic` step would call back into the DO
  across the Workflow↔DO boundary. The DO stays the coordination point; we add a
  second execution engine on top of it.
- **Migration cost is large.** The webhook→`enqueueTurn`→alarm path, the typing
  loop, the busy flag, alarm backoff, onboarding, and admin tasks all assume
  in-DO execution. Rehoming the turn into a Workflow reworks all of it.
- **1 MiB step return** fits the ~300 KB message array today but is a ceiling to
  watch; large research reports must return an R2 reference if they ever grow.
- Same fundamental limit as Option A: an **in-flight** LLM call at deploy time
  still re-runs; only completed steps are durable. Workflows do not buy
  resumability of a half-finished generation.

Workflows are the right tool for a genuinely long, multi-stage, mostly-waiting
job (e.g. research decoupled into an async ack-then-deliver pipeline). They are a
heavy answer to "don't discard one finished result on reset," and they fight the
DO-centric design for that narrow win.

## Recommendation

**Land the cheap partial form of Option A first, and do not adopt Workflows now.**

1. **Checkpoint completed research results in DO SQLite (the 80%).** Persist each
   research report the instant the `research` tool returns, keyed by turn
   identity `(conversationId, tailUserMessageId, promptHash)`. On any retry of
   the same turn, the `research` tool returns the cached report without calling
   the model or web search. This directly removes both incident harms: the retry
   is cheap (seconds, not 10 min) and it delivers the real answer instead of the
   fallback. It changes nothing about delivery ordering, so it cannot introduce a
   duplicate.

2. **Keep persist-before-send.** Do not switch to send-then-persist. Send-then-
   persist would, on a reset landing between send and persist, deliver the answer
   but leave the thread tail `user`, so the retry re-runs and sends a **second**
   answer — a duplicate, plus the fallback. Persist-before-send keeps the
   no-duplicate invariant (`docs/topics.md`); the research checkpoint is
   orthogonal and makes the eventual retry both cheap and correct.

3. **Defer the full per-step checkpoint (Option A full) and Workflows (Option B)**
   until evidence shows non-research turns also lose expensive work. The partial
   fix covers the only unit whose redo is measured in minutes and dollars.

Why partial-first is right: the research result is the one work unit that is both
expensive to redo and safe to store and replay (read-only, pure text). A plain
answer is cheap to regenerate. So a small, well-scoped checkpoint captures nearly
all the value; the general machinery (and its side-effect idempotency guards, or
a whole new execution engine) is disproportionate to the remaining risk.

**Honest answer to the framing question: a DO reset mid-turn is not avoidable,
only survivable.** Cloudflare's own docs say a DO is replaced on any code
deployment or platform update and loses in-memory state; gradual deployments only
shrink and stretch the window. The design must therefore make the turn resumable
from durable checkpoints and must never assume the isolate survives to the end of
the turn.

## Do-not-lose-a-generated-answer, precisely

- You cannot make a single SQLite write atomic with a Telegram `fetch`, and the
  reset can kill exactly the write that records "we answered." So no ordering of
  persist/send makes the *first attempt* immune.
- The achievable guarantee is **cheap, correct redelivery on the retry**: if the
  expensive inputs (the research result) are already committed, the retry
  recomposes and delivers the true answer in seconds instead of emitting a
  fallback after a 10-min redo. That is what the research checkpoint buys.
- Residual, unchanged tradeoff (documented in `docs/topics.md`): if a reset lands
  between two `reply()` calls within one turn, the retry skips the thread (tail
  already `assistant`) and the second reply is lost — a rare "partial turn," still
  preferred over a duplicate. The writer consolidation for a skipped-retry turn
  also does not re-run; with research now checkpointed, a follow-up could persist
  research findings even on a skipped writer, but that is out of scope here (see
  Risks).

## Idempotency of a resumed turn

- **Turn identity** is `(conversationId, tailUserMessageId)`: the retry answers
  the same tail user message, so a cache keyed on it is stable across the retry.
  `getConversationHistory` currently drops the message `id`; expose it (or read
  the tail id directly) so the turn key is available. Clear a conversation's turn
  cache when its reply commits (tail becomes `assistant`) and on `/new`.
- **Research replay** is side-effect-free (read-only tools, pure text), so a
  cache hit is safe and returns immediately.
- **Reply delivery** stays governed by persist-before-send plus
  `findThreadsAwaitingReply` skipping a thread whose tail is `assistant`. No
  change, no new duplicate path.

## Observability

Today the failure was learned only from a user complaint. Add:

- `research_cache_store` when a report is checkpointed, and `research_cache_hit`
  (or a turn-level `turn_resumed`) when a retry serves a cached report. Include
  the turn key and report length. These make resumes countable in Workers Logs.
- A distinct ZeroErrors signal (e.g. `turn_reset_recovered`) reported when a
  retry reuses a checkpoint, separate from the raw "Durable Object reset" error,
  so a recovered turn is visible as a positive event, not just an error.
- Keep the existing DO-reset error reporting. A dashboard count of
  `research_cache_hit` per day (with an alert threshold) surfaces reset-during-
  research frequency without waiting for a complaint.

## Ordered steps

1. **Add a turn-cache table.** New migration: `turn_cache(conversationId,
   userMessageId, kind, key, value, createdAt)` (kind = `research`, key =
   promptHash). Add `Store` methods `getTurnCache`/`putTurnCache`/
   `clearTurnCache(conversationId)` to both adapters (`DbStore`, `MemoryStore`)
   and the shared contract test.
2. **Expose the tail user message id** to the orchestrator (extend
   `getConversationHistory` or add a small read) so the turn key is available.
3. **Wire the research tool to the cache.** In `tools/research.ts`, before
   running the agent, look up `(conversationId, userMessageId, promptHash)`; on a
   hit, log `research_cache_hit`, merge the cached `accessed` names, and return
   the cached report. On a miss, run as today, then `putTurnCache` the report and
   log `research_cache_store`. Thread `conversationId` + `userMessageId` from the
   orchestrator through `runInterfaceAgent` into `buildResearchTool`.
4. **Clear the cache on reply commit and on reset conversation.** When the
   turn's reply row is persisted (tail becomes `assistant`) and in
   `resetConversation`, call `clearTurnCache` so cached reports do not leak into
   an unrelated later turn with a colliding key.
5. **Add observability.** The two log events above plus the
   `turn_reset_recovered` ZeroErrors report.
6. **Changelog + docs.** Add a user-facing bullet to `apps/agent-api/CHANGELOG.md`
   (e.g. "If Zero is interrupted while researching, it now finishes your original
   answer instead of asking you to try again."). Update `docs/topics.md`
   (execution / reset section) and `docs/research.md` to describe the research
   checkpoint and the resume semantics.

## Test strategy

Honestly testable on this box (unit, MemoryStore + scripted model, no workerd):

- Research report is written to the turn cache on completion (assert a
  `turn_cache` row via the contract-tested `Store`).
- A second interface run with the same turn key and a scripted model that *would*
  call research returns the cached report and records **zero** research
  generations (assert the model's call log).
- Simulated reset: run the interface once to populate the cache, then run a fresh
  interface (new agent objects, same `Store`, same turn key) and assert research
  is not re-invoked and the answer is delivered exactly once.
- persist-before-send ordering and `decideFinalDelivery` unchanged (existing
  tests stay green).
- `findThreadsAwaitingReply` still skips a thread whose tail is `assistant`
  (existing behavior, assert no duplicate on re-run).
- Log events emitted at the right points (log spy).
- `store-contract.test.ts` covers the new cache methods for both adapters.

Not honestly testable here: a real DO isolate reset on deploy needs workerd plus
a real version rollout; the e2e harness needs workerd, which cannot run on this
box (see root `AGENTS.md`). Reset survival is therefore proven by the simulated-
reset unit test plus the staged production test below.

## Production verification (staging the acceptance test safely)

The acceptance test is a deliberate deploy during a long turn, confirming no work
is lost and no duplicate is sent. Stage it against a **test chat / test user DO**,
never a real user:

1. Start `wrangler tail` on `zero-api` and open the AI Gateway `zero` logs.
2. From the test chat, send a prompt known to trigger a multi-step research loop
   (long enough to hold the turn mid-research for ~1-2 min, widening the reset
   window).
3. When `research_started` appears (and the gateway shows the research context
   ramping), force a deploy: `gob run bin/deploy` (or push a trivial change).
   Prefer a gradual rollout so the DO resets when traffic shifts to the new
   version; repeat the deploy within the window if the first does not land on
   that DO.
4. Confirm from logs and the chat:
   - a "Durable Object reset because its code was updated" event fires, then
   - a `research_cache_hit` / `turn_resumed` on the retry, and **no** second full
     research ramp (no fresh `research_started` climbing context from baseline),
   - exactly **one** substantive answer reaches the test chat,
   - **zero** `FALLBACK_MESSAGE` sent,
   - the turn's AI Gateway cost is ~single-run, not doubled.

## Acceptance criteria (objectively checkable)

1. A completed research call writes its report to `turn_cache` (unit-asserted row
   keyed by conversation + tail user message + prompt hash).
2. A retry of the same turn returns the cached research report with **zero**
   research LLM generations (unit-asserted model call count).
3. Persist-before-send ordering is unchanged and no code path sends before the
   assistant row is committed (existing tests pass; a reply row exists before
   `send` is invoked).
4. Re-running a turn whose reply row already exists sends no duplicate (tail
   `assistant` is skipped by `findThreadsAwaitingReply`).
5. `research_cache_store` and `research_cache_hit` (or `turn_resumed`) log events
   are emitted at the store and hit points, and a `turn_reset_recovered`
   observability signal fires on a checkpoint-recovered retry.
6. Staged production test: a forced deploy during a mid-research turn on a test
   chat yields exactly one substantive answer, zero fallback messages, and logs
   show the research loop was not re-run from scratch; the turn's gateway cost is
   ~single-run.
7. The turn cache is cleared on reply commit and on `resetConversation` (unit-
   asserted), so a cached report cannot leak into a later unrelated turn.

## Risks, dependencies, mitigations

- **Turn-key collision.** If a user re-sends an identical message in the same
  conversation, the promptHash could collide and serve a stale report. Mitigate
  by keying on the tail `userMessageId` (unique per message row) and clearing the
  cache on reply commit, so a cache entry lives only for the lifetime of one
  in-flight turn.
- **Cache never cleared → stale reuse.** Clear on reply commit, on
  `resetConversation`, and defensively TTL rows (createdAt) so an abandoned turn
  cannot serve a report much later.
- **Writer redo on a skipped retry** still drops that turn's consolidation (the
  documented `docs/topics.md` tradeoff). Research findings persisted by the writer
  can thus be lost if a reset lands after the reply but before the writer. Out of
  scope here; a later step could persist research findings independently of the
  writer, or promote the checkpointed report into a topic on a skipped-writer
  retry.
- **In-flight LLM generation is still lost** on a reset (no scheme resumes a
  half-finished Anthropic call). Accepted: the retry restarts that one call, and
  with research cached the restart is cheap.
- **Scope creep toward Option A full / Workflows.** Resist unless logs show
  non-research turns losing expensive work; the partial fix is deliberately
  minimal.
- **Dependency:** the fix lives entirely in `apps/agent-api` (store, research
  tool, interface/orchestrator threading, a migration). No cross-worker change,
  no new binding. Shrinking the reset window at the source (scoped Workers Builds
  watch paths, spaced pushes) is already shipped and complementary, not a
  substitute.

## Skills to use during implementation

- `code` — turning these steps into the store methods, migration, and research-
  tool wiring.
- `tdd` — the store-contract and research-cache unit tests are a natural
  red-green loop.
- `testing` — deciding the cache seam and what to assert without a real DO.
- `cloudflare` — DO storage/reset semantics reference if the design shifts.
- `changelog` — the user-facing CHANGELOG bullet.
- `reproducible-locally` — framing the staged production deploy-verify.
- `git-commit` — committing code, tests, migration, changelog, and docs together.
```
