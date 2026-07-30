# PR #40 review fixes

Six correctness findings on branch `agent-normal-interface` (PR #40, "Make the
interface a normal agent and move learning off the turn path"). All six were
confirmed against the code. None are stylistic; three are data-loss or
hard-failure paths, three are narrower correctness holes. Nothing here is
deployed yet, so all of it is pre-merge work on the same branch.

Background the fixes depend on:

- The conversation transcript is the durable agent log. Each assistant response
  is persisted before its tools run; each text block is claimed in the
  `deliveries` table before it is sent to Telegram (claim-then-send, at most
  once).
- `conversationHasWork` (`store/messages.ts`) is the single protocol predicate
  for "does this conversation owe work". Two callers: `runTurn`
  (`agents/orchestrator.ts`) and `findConversationsWithWork` (`store/db.ts`),
  the latter being what the alarm uses to pick threads. Both must agree, or a
  thread is either never picked up or picked up and immediately dropped.
- A conversation is rendered as `summary + rows after the compaction boundary`.
  Compaction (in `LearningDO`) moves the boundary forward and stores prose for
  everything behind it. It deletes nothing: the raw rows are what learning
  reads.
- Learning jobs freeze a high-water message id at `beginJob` and stamp
  `consolidatedAt` on completion.
- `ScheduleDO` owns every deadline (idle learn, size learn, onboarding, admin
  task) because a Durable Object has exactly one alarm.

## Goal

Close all six holes with the existing module shapes, keep the store contract
tests and both store adapters (`store/db.ts`, `store/memory.ts`) in sync, and
add a regression test per finding at the seam where the bug lives.

## Fix 1 — a persisted reply that was never sent is lost

`agents/orchestrator.ts:106`, `store/messages.ts`, both stores.

`conversationHasWork` calls a terminal assistant tail idle. `deliverUnclaimed`
(the retry that sends persisted-but-unsent text) only runs inside
`runInterface`, past that early return. A reset between `persistAssistant` and
`claimDelivery` therefore leaves a reply that is persisted, never sent, and
never retried: `findConversationsWithWork` will not offer the thread and
`runTurn` would return before delivering it anyway.

Changes:

- Extract delivery from `agents/interface.ts` into `agents/delivery.ts`:
  `deliverUnclaimed({ rows, claim, send })`, where `claim` is
  `store.claimDelivery`. Pure of the agent loop, so it can be called from both
  the orchestrator and the interface. Interface keeps calling it (the second
  call is a no-op because the claims already exist).
- Extend `conversationHasWork` with an `undelivered: boolean` input, true when
  the tail is a terminal assistant row with a non-empty text block that has no
  delivery claim. Add a pure helper in `store/messages.ts`
  (`unclaimedBlockIndexes(content, claimedIndexes)`) so both stores compute it
  the same way, and a store method `unclaimedTailBlocks(conversationId)` (or
  fold it into the existing tail read) implemented in `store/db.ts` and
  `store/memory.ts`.
- `runTurn`: call `deliverUnclaimed` on the rows after the last user message
  **before** the work check, then apply the check as today. A thread whose only
  work was an unsent block delivers and returns without an LLM call.

Tests: store-contract test that a claimed-nothing terminal assistant tail is
reported as work and a fully claimed one is not; orchestrator test that a
transcript ending in a persisted-but-unclaimed assistant reply sends exactly
that text and makes no model call; existing "no duplicate send" tests must stay
green.

## Fix 2 — compaction skips rows it summarizes past

`store/db.ts:395` (`getConversationContext`), `LearningDO/index.ts:190-215`.

`getConversationContext` returns the **newest** `limit` rows after the boundary.
Compaction reads 200 of them and then sets the boundary to the newest row of
that window, so with more than 200 post-boundary rows everything older than the
window is jumped over and never enters any summary. Silent, permanent history
loss.

Changes:

- Add a forward-paging read for compaction. Either a new store method
  `listMessagesAfterBoundary(conversationId, { afterId, limit })` returning rows
  in ascending id order, or a `direction`/`from` option on the existing context
  read; prefer the separate method so the turn-path interface is untouched.
  Expose it on `LearningPort` (`learning/types.ts`, `store-port.ts`,
  `remote-port.ts`, plus the `UserDO` RPC method) alongside the existing
  `getContext`.
- Compaction summarizes from the **old boundary forward**, never from the tail,
  so the new boundary is always contiguous with the old one.
- When the window does not reach the tail (a full page came back), compact that
  page and request another compaction pass rather than one giant summary; the
  existing successor-job machinery in `do/learning-job.ts` is where that queues.
- Turn rendering keeps its `CONTEXT_MESSAGE_PAGE` newest-rows cap as a backstop,
  but truncating from the top can start the rendered context with an orphan
  `tool_result`. Apply the same protocol-safe trim as Fix 3 to the front of the
  rendered window (drop leading rows until the first row is a user message).

Tests: store-contract test for the forward read paging from a boundary;
LearningDO test with 300 post-boundary rows asserting the new boundary is
contiguous (no row between old and new boundary is missing from the summarized
input).

## Fix 3 — compaction can cut between `tool_use` and `tool_result`

`LearningDO/index.ts:200` (`context.messages.slice(0, -4)`).

Four rows is not one exchange. In a multi-step turn the cut can fall between an
assistant `tool_use` row and its `tool_result` row, leaving the rendered context
starting with an orphan `tool_result`, which Anthropic rejects — a 400 on every
turn of that conversation until the boundary moves again.

Changes:

- Add a pure `safeCompactionCut(messages, { keepTail })` to `store/messages.ts`:
  scan the candidate prefix backwards for the last assistant row with a terminal
  stop reason and cut after it; return `null` when there is none, in which case
  compaction logs `learn_skipped` and leaves the boundary alone.
- `keepTail` preserves the current intent ("do not summarize what the user is
  still talking about") but expressed in exchanges, not rows.
- Reuse the same predicate for the front-trim in Fix 2.

Tests: unit tests on `safeCompactionCut` for a `tool_use`/`tool_result` pair
straddling the naive cut, for a window with no terminal assistant row, and for
the ordinary case; a LearningDO test asserting the post-compaction rendered
context begins with a user message.

## Fix 4 — a truncated learning job marks unseen messages consolidated

`LearningDO/index.ts:182`, `store/db.ts:546` (`completeLearningJob`).

`pageMessages` caps its input at `MAX_JOB_MESSAGES` (400) but
`completeLearningJob` stamps `consolidatedAt` on every row up to the job's
frozen high-water id. Rows 401+ are marked learned without ever being shown to
the learner, permanently.

The cap itself is also unjustified: 400 appears with no derivation in the code
comment, in commit `2b99550`, or in `PLAN.md`. What it is really guarding is the
learner's prompt, because `runLearnerSlice` renders every job message into a
single prompt via `renderLearningLog` (`agents/learner.ts`), with each tool
result truncated at 2000 chars. A message count is a poor proxy for that: 400
tool-heavy messages and 400 one-line messages differ by an order of magnitude in
rendered size. Fix the truncation and the bound together.

Changes:

- `completeLearningJob(jobId, throughMessageId)` stamps
  `min(highWater, throughMessageId)` — never wider than what was processed —
  keeping its existing idempotency by job id. Thread `throughMessageId` through
  `LearningPort.completeJob`, both port adapters, and the `UserDO` RPC.
- `LearningDO` passes the id of the last message actually handed to the learner.
- When the page hit the cap, request a successor job immediately so the
  remainder is not left waiting for the next idle or size trigger.
- Replace `MAX_JOB_MESSAGES` with a rendered-size budget. Page forward and stop
  when the rendered log crosses `LEARN_JOB_BUDGET_TOKENS`, measured with the
  existing `estimateTokens` helper in `store/messages.ts` over the same
  rendering the prompt uses, so the number bounds the resource that actually
  matters. Keep a generous row ceiling as a second backstop against a
  pathological loop, not as the primary bound.
- The budget ships as an explicit guess, like the compaction threshold: pick a
  value well under the context window (a few tens of thousands of tokens), state
  in the comment that it is a guess, and log the job's rendered token count on
  `learn_started` so the real distribution can move it.
- Cutting the page mid-turn is fine here — the learner reads prose, not the wire
  protocol, so the protocol-safe rule from Fix 3 does not apply. Cut on a
  message boundary and let the successor continue.

Tests: store-contract test that completion with a `throughMessageId` below the
high-water leaves later rows unconsolidated and that a repeated call is still a
no-op; LearningDO test that a backlog exceeding the budget consolidates in two
jobs with no gap; a unit test that a page of large tool-result messages stops
earlier than a page of short messages.

## Fix 5 — a failed dispatch drops the deadline

`ScheduleDO/index.ts:63`, `do/schedule.ts`.

`takeDueDeadlines` deletes every due entry before dispatch, and the catch only
logs. `idle` and `size` self-heal (the next user message touches the schedule
again), so the real loss is `onboarding` and `admin_task`, which have no other
trigger.

Changes:

- Add `attempts?: number` to `Deadline` and a pure
  `retryDeadline(entry, now)` in `do/schedule.ts`: exponential backoff (1 min
  doubling, capped at 1 h), giving up after a small number of attempts with an
  explicit `schedule_dispatch_gave_up` log line.
- `ScheduleDO.alarm` reschedules the failed entry through `scheduleDeadline`
  instead of only logging. Re-arming by key means a fresh request for the same
  reason replaces the retry, which is the wanted behavior.

Tests: unit tests on `retryDeadline` (backoff, cap, give-up); a ScheduleDO test
where the first dispatch throws and the entry is still present with a later
`dueAt`, and where the other due entries in the same invocation still dispatch.

## Fix 6 — an ambiguous external-call failure is recorded as a known failure

`agents/run.ts:288`, `tools/google.ts`, `google/rest.ts`.

The catch comments that "a throw means the tool itself reported failure", which
is not provable: a fetch that times out reading the response after Gmail
accepted the send throws identically to a rejected request. Recording it
complete-with-error invites the model to retry under a new `tool_use` id and
duplicate an irreversible action, breaking the at-most-once claim the same file
establishes 30 lines above.

Note that for the two `externalWrite` tools the failure does not even arrive as
a throw today: `tools/google.ts`'s `guard` swallows every error into
`{ error }`, so run.ts sees a value and records it as a completed call. Both
paths need the fix.

Changes:

- Add `ExternalCallNotSent` (a typed error) in a small module next to the
  external-call bookkeeping. It means: the request provably never reached the
  provider, or the provider rejected it without side effect.
- `google/rest.ts`: throw a `GoogleApiError` carrying the HTTP status instead of
  a bare `Error`, so callers can classify.
- `tools/google.ts`: `gmail_send` and `calendar_create_event` use a write-path
  guard that maps `GoogleNotConnectedError` and 4xx-except-408/429 into
  `ExternalCallNotSent` and lets everything else propagate unchanged. They must
  not swallow ambiguous errors into `{ error }`.
- `agents/run.ts` catch, for `externalWrite` tools with a guard:
  `ExternalCallNotSent` → `guard.complete(id, message)` plus the ordinary error
  result (the model may retry); anything else → **leave the claim in flight**
  and return `errorResult(UNCERTAIN_EXTERNAL_CALL)`, so a later replay of the
  same id also reports uncertain.

Tests: run.ts tests for an external-write tool that throws a generic error
(claim stays in flight, result is the uncertain text, a replay of the same id
repeats it) and one that throws `ExternalCallNotSent` (claim completed, normal
error, a new call id is allowed); google tool tests for the status
classification.

## Docs

- `docs/topics.md`: compaction now pages forward from the boundary and cuts only
  after a terminal assistant response; note the delivery-retry path is part of
  the work predicate.
- `docs/google-tools.md`: the not-sent versus ambiguous classification for the
  two irreversible tools.
- Root `PLAN.md` on this branch: mark these six as closed where it lists
  post-merge verification.
- No changelog entry. The branch's user-visible behavior is already described in
  `apps/agent-api/CHANGELOG.md` (2026-07-30 entries) and none of it has shipped,
  so these are fixes to unreleased work.

## Skills to use

- `tdd` — every fix has a cheap failing test at an existing seam; write it first.
- `testing` — the store-contract suite runs against both adapters; new store
  methods belong there, not in one adapter's test file.
- `deep-modules` — for the `agents/delivery.ts` extraction and the compaction
  read seam on `LearningPort`.
- `git-commit` — one commit per fix, in the order above.
- `open-pr` — the branch already has PR #40; push and reply to each review
  comment with the commit that closes it.

## Acceptance criteria

- `pnpm --filter @zero/agent-api run test | lint | typecheck` pass; every new
  behavior above has a test that fails before its fix.
- No `slice(0, -N)` row-count cut survives in the compaction path.
- `completeLearningJob` cannot stamp a row the learner never saw.
- A dispatch failure in `ScheduleDO` leaves the deadline in storage.
- No code path completes an external-call claim for an error that does not prove
  the request never left.
- `conversationHasWork` agrees with the delivery retry: any conversation holding
  an unclaimed assistant text block is reported as work by both callers.
