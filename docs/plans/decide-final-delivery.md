# Extract a pure `decideFinalDelivery` from `runInterfaceAgent`

## Goal

The interface agent's final-delivery decision (the no-silence / echo / fallback
branch matrix — deciding what final message, if any, is delivered to the user)
is currently entangled inside `runInterfaceAgent`, so the silent-reply and
duplicate-reply regression classes there can't be unit tested directly. Extract
that decision into a PURE function `decideFinalDelivery(inputs) -> decision` and
cover the whole branch matrix with direct unit tests. Behavior must be preserved
exactly (this logic guards known regression classes; see docs/topics.md — replies
persisted before send, alarm re-fire self-heal, no duplicates).

This is architecture-review finding #4 (`docs/plans/architecture-review.md`).
Findings #1–#3 are already merged.

## Findings

### Where the decision lives

`apps/agent-api/src/agents/interface.ts`, the tail of `runInterfaceAgent` after
`runAgent` returns. The relevant slice, verbatim:

```ts
// A `reply` send failed and the AI SDK swallowed it. Re-raise ...
if (firstSendError !== null) throw firstSendError as Error;

const lastReply = replies[replies.length - 1]?.trim();

// Clean finish: the model's final message is the substantive answer, so
// deliver it — unless it is empty or an exact echo of the reply we already
// sent. ...
if (finishReason === "stop" && text.trim() && text.trim() !== lastReply) {
  persistReply(text);
  await input.send(text);
  replies.push(text);
  return { replies, accessed: [...accessed], transcript };
}

// Cap cut-off (finishReason !== "stop"), or a clean finish that produced no
// final message and never sent a reply: the model never produced its intended
// answer. Send a fallback so the user is never left in silence. ...
if (finishReason !== "stop" || replies.length === 0) {
  log("turn_incomplete", { finish_reason: finishReason, steps });
  persistReply(FALLBACK_MESSAGE);
  await input.send(FALLBACK_MESSAGE);
  replies.push(FALLBACK_MESSAGE);
}

return { replies, accessed: [...accessed], transcript };
```

### Inputs the decision actually depends on

Only three values, all plain data:

- `finishReason: string` (from `runAgent`; the decision only tests `=== "stop"`).
- `text: string` — the model's final prose. Delivered **raw** on the send branch
  (`persistReply(text)` / `send(text)` / `replies.push(text)`), but compared
  **trimmed** for the empty and echo guards.
- `replies: string[]` — the replies already sent this turn. The decision reads
  `replies.length` (any reply sent?) and `replies[last]?.trim()` (echo compare).

Nothing else in the tail feeds the decision. `steps` is only used in the
`turn_incomplete` log line, not in the branch condition. `accessed`,
`transcript`, `usage`, `firstSendError` are unrelated to the delivery choice.

### The branch matrix (current behavior, exhaustive)

Let `clean = finishReason === "stop"`, `trimmed = text.trim()`,
`echo = trimmed === replies[last]?.trim()`, `hasReplies = replies.length > 0`.

Three code branches produce three actions. Enumerated over meaningful input
combinations, the matrix has **6 distinct rows**:

| # | finishReason | final text | prior replies | Action |
|---|---|---|---|---|
| 1 | `stop` | non-empty, not echo | none | **send** final text |
| 2 | `stop` | non-empty, not echo | ≥1, non-echo | **send** final text (the regression case: ack-then-answer must not be suppressed) |
| 3 | `stop` | echoes last reply | ≥1 | **none** (suppress; already delivered) |
| 4 | `stop` | empty / whitespace | ≥1 | **none** (suppress; the reply was the answer) |
| 5 | `stop` | empty / whitespace | none | **fallback** (clean finish, said nothing) |
| 6 | not `stop` (cap cut-off) | any | any (with or without ack) | **fallback** |

Derivation of the fall-through (row 3/4 "none"): reached only when the send `if`
is false **and** the fallback `if` is false, i.e. `clean && hasReplies &&
(!trimmed || echo)`. Row 6 covers both cap-cutoff-with-no-reply and
cap-cutoff-after-an-ack (both hit `finishReason !== "stop"`), so the `hasReplies`
split does not change the cap-cutoff outcome.

### Side effects that must stay in the runner (the pure fn only DECIDES)

- `persistReply(...)` (persist-before-send; keeps DO-eviction retries idempotent
  — see docs/topics.md "Replies are persisted as they are sent").
- `await input.send(...)` (Telegram delivery).
- `replies.push(...)` (so the returned `InterfaceAgentResult.replies` reflects
  what went out).
- `log("turn_incomplete", { finish_reason, steps })` on the fallback path.
- The `firstSendError` re-raise (runs **before** the decision; unchanged).
- `renderTranscript`, `interface_completed` / `interface_step_usage` logging.

The pure fn does no I/O, no store/bot/DO access, no logging, no mutation of
`replies`. It takes plain data and returns a decision; the runner executes it.

### Existing coverage (nothing to lose)

`apps/agent-api/src/agents/interface.test.ts` already exercises every row through
the full agent run with a scripted model:

- Row 1 — "sends the final text when the model never calls reply".
- Row 2 — "delivers the final message even after an earlier reply" and
  "delivers the post-research answer sent as final prose after an ack reply".
- Row 3 — "does not re-send the final text when it echoes the last reply".
- Row 5 — "sends the fallback when the model calls no reply and returns empty
  text".
- Row 6 — "sends the fallback and logs turn_incomplete when the loop hits the
  step cap" and "sends the fallback after an ack reply when the loop hits the
  step cap".
- Persist-before-send order — "persists each reply before sending it" and
  "persists the prose fallback before sending it".

These stay as wiring coverage. Row 4 (clean finish, has reply, empty final text)
is only covered indirectly; the new pure tests make it explicit. No e2e test in
`packages/agent-e2e` targets this decision directly; the branch matrix moves to
fast pure unit tests.

## Design of the pure function

In-process, pure computation — category 1 (deep-modules): merge the decision into
one testable function, no port, no adapter. New exports in `interface.ts`
(keeps `FALLBACK_MESSAGE` and the runner co-located):

```ts
export interface FinalDeliveryInput {
  finishReason: string;
  text: string;
  replies: string[];
}

export type FinalDelivery =
  | { action: "send"; text: string }      // deliver the model's final prose (raw text)
  | { action: "fallback" }                 // deliver FALLBACK_MESSAGE + log turn_incomplete
  | { action: "none" };                    // suppress: nothing to deliver

export const decideFinalDelivery = (
  input: FinalDeliveryInput,
): FinalDelivery => {
  const lastReply = input.replies[input.replies.length - 1]?.trim();
  const trimmed = input.text.trim();
  if (input.finishReason === "stop" && trimmed && trimmed !== lastReply) {
    return { action: "send", text: input.text };
  }
  if (input.finishReason !== "stop" || input.replies.length === 0) {
    return { action: "fallback" };
  }
  return { action: "none" };
};
```

Design notes:

- `send` carries the **raw** `input.text` (not trimmed), preserving the current
  `persistReply(text)` / `send(text)` bytes exactly.
- `fallback` carries no text: `FALLBACK_MESSAGE` is the runner's constant and the
  `turn_incomplete` log is a runner side effect, so the runner owns both. This
  keeps the pure fn free of the log and lets it stay a plain data decision. (The
  discriminant alone tells the runner which message and whether to log.)
- The two `if`s preserve original precedence: the send condition is checked
  first (it `return`ed early in the original), so an echo/empty clean finish
  falls through to the fallback/none split identically.

### The seam

Internal in-process seam inside `interface.ts`. The runner keeps its external
interface (`InterfaceAgentInput` -> `InterfaceAgentResult`) unchanged; the pure
fn is a private-ish helper exported only so the test can reach it. No change to
`orchestrator.ts`, `run.ts`, tools, or the `Store` port.

### Runner rewrite

Replace the two-`if` tail with a call plus an executor. Everything above
`const lastReply = ...` (including the `firstSendError` re-raise) is unchanged.

```ts
if (firstSendError !== null) throw firstSendError as Error;

const decision = decideFinalDelivery({ finishReason, text, replies });
if (decision.action === "send") {
  persistReply(decision.text);
  await input.send(decision.text);
  replies.push(decision.text);
} else if (decision.action === "fallback") {
  log("turn_incomplete", { finish_reason: finishReason, steps });
  persistReply(FALLBACK_MESSAGE);
  await input.send(FALLBACK_MESSAGE);
  replies.push(FALLBACK_MESSAGE);
}

return { replies, accessed: [...accessed], transcript };
```

Delete the now-unused `const lastReply` (folded into the pure fn). The
`if/else if` gives the same mutual exclusivity the early `return` gave: `send`
never also runs `fallback`; `none` does nothing. Same persist-before-send order,
same `replies.push` bytes, same log line.

## Test strategy

Add a `describe("decideFinalDelivery")` block to `interface.test.ts` (or a new
`interface.test.ts` sibling if preferred; co-locating is fine). Pure input ->
output assertions, no store/model/mock. Cover every matrix row plus the
whitespace edges the guards depend on:

1. clean + non-empty text + no replies -> `{ action: "send", text }` (row 1).
2. clean + non-empty text + prior non-echo reply -> `{ action: "send", text }`
   (row 2, the ack-then-answer regression: an earlier reply must not suppress).
3. clean + text exactly echoes last reply -> `{ action: "none" }` (row 3).
4. clean + text echoes last reply **modulo surrounding whitespace** -> `none`
   (echo compares trimmed both sides).
5. clean + empty text + prior reply -> `{ action: "none" }` (row 4).
6. clean + whitespace-only text (`"   "`) + prior reply -> `{ action: "none" }`
   (whitespace treated as empty).
7. clean + empty text + no replies -> `{ action: "fallback" }` (row 5).
8. not-`stop` (e.g. `"tool-calls"`) + **empty** text + no replies ->
   `{ action: "fallback" }` (row 6a).
9. not-`stop` + **empty** text + prior ack reply -> `{ action: "fallback" }`
   (row 6b: cap cutoff after an ack still falls back).
10. not-`stop` + **non-empty** text (`"some answer"`) + no replies ->
    `{ action: "fallback" }` (verify concern 1: the produced final text is
    discarded on a cap cut-off; a regression that sent leftover text on a
    non-`stop` finish would otherwise slip through — cases 8/9 use empty text and
    can't distinguish "fallback because not stop" from "fallback because empty").
11. not-`stop` + **non-empty** text + prior ack reply -> `{ action: "fallback" }`
    (verify concern 1, ack variant: `finishReason` drives fallback independent of
    both text content and prior replies).
12. `send` returns the **raw** untrimmed text (e.g. text `"answer\n"` yields
    `{ action: "send", text: "answer\n" }`), proving delivered bytes are
    preserved (raw-vs-trimmed: guards compare `text.trim()`, delivery carries raw
    `input.text`).
13. clean + text echoes an **earlier, non-last** reply (e.g. replies
    `["hi", "different"]`, text `"hi"`) -> `{ action: "send", text }` (verify
    concern 2: the echo guard compares only `replies[last]`, so echoing a
    non-last reply must not suppress; locks the "last reply only" semantics
    against a future "compare against all replies" regression).
14. `fallback` and `none` decisions carry **no** `text` field: assert exact
    shape `{ action: "fallback" }` / `{ action: "none" }` (verify nit 1: locks
    the "runner owns FALLBACK_MESSAGE" contract — the discriminant alone tells
    the runner which message to send).

Keep the existing full-run tests in `interface.test.ts` as wiring coverage
(they prove the runner executes each decision with the right persist/send/log
side effects). Do not delete them — they cover the seam the pure tests can't
(persist-before-send ordering, `turn_incomplete` logging, the `firstSendError`
re-raise path). No new mocks; the pure tests need none.

## Preservation argument

- The pure fn reproduces both original conditions byte-for-byte:
  `finishReason === "stop" && text.trim() && text.trim() !== lastReply` for
  send, and `finishReason !== "stop" || replies.length === 0` for fallback, with
  `lastReply = replies[last]?.trim()`. The fall-through is the same `none`.
- `send` carries raw `text`; the runner still does `persistReply/send/push` with
  that raw value, so delivered content is identical.
- The original early `return` after send is replaced by `else if`, which is
  logically equivalent (send and fallback were already mutually exclusive: after
  a successful send the function returned; if send did not fire, the fallback
  `if` ran). No third path can now fire two sends.
- `turn_incomplete` still logs with the same `{ finish_reason, steps }` on the
  same fallback condition.
- Everything before the decision (error re-raise, transcript, usage logs) is
  untouched.
- The existing full-run tests pin the observable behavior; they must stay green
  unchanged, which is the regression guard.

## Verification

Per AGENTS.md (workerd can't boot on the dev box, so verify the touched package
directly; CI runs the workerd/e2e suites):

```bash
pnpm --filter @zero/agent-api run test
pnpm --filter @zero/agent-api run lint
pnpm --filter @zero/agent-api run typecheck
```

All existing `interface.test.ts` cases must pass **unchanged** (behavior
preservation), and the new `decideFinalDelivery` block must pass. Rely on GitHub
Actions CI for the e2e / cross-worker suites.

## Changelog

None. Purely internal refactor (extract-and-test, behavior identical). Per
AGENTS.md the changelog is for user-observable changes only; there is no
user-visible change here. Confirmed: no entry in `apps/agent-api/CHANGELOG.md`.

## Skills to use

- `deep-modules` — classifying the seam (in-process, category 1) and keeping the
  pure fn out of the runner's external interface.
- `testing` — pure input/output tests at the new interface; keep the existing
  full-run tests as wiring coverage, don't couple new tests to internals.
- `tdd` — write the `decideFinalDelivery` cases first, then extract until green.
- `git-commit` — single refactor commit when done.

## Acceptance criteria

- `decideFinalDelivery` exists in `interface.ts`, is pure (no I/O, no store/bot/
  DO/log access, no mutation of `replies`), and takes `{ finishReason, text,
  replies }` returning `{ action: "send"; text } | { action: "fallback" } |
  { action: "none" }`.
- `runInterfaceAgent` calls it and only executes the decision (persist, send,
  push, and the `turn_incomplete` log on fallback); the `firstSendError`
  re-raise stays ahead of the decision.
- New unit tests cover all 6 matrix rows plus whitespace-empty, whitespace-echo,
  raw-text-preservation, non-`stop`-with-non-empty-text (fallback still discards
  the text — verify concern 1), non-last-reply-echo (still sends — verify concern
  2), and the no-`text`-field shape of `fallback`/`none` (verify nit 1) edges
  (≈14 cases).
- The now-unused `const lastReply` line is removed from the runner (it moves into
  the pure fn), keeping lint green (verify nit 2).
- All pre-existing `interface.test.ts` cases pass unchanged.
- `test`, `lint`, `typecheck` green for `@zero/agent-api`.
- No changelog entry.
