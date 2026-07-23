# Verification: extract `decideFinalDelivery`

Verdict: **GO**. 0 blockers, 2 concerns, 2 nits.

Scope reviewed: `apps/agent-api/src/agents/interface.ts` tail of
`runInterfaceAgent`, `interface.test.ts`, `docs/topics.md` (persist-before-send
/ self-heal), and `orchestrator.ts` fallback boundary. The plan's verbatim quote
of the tail matches the current source exactly (`interface.ts`, the block from
`if (firstSendError !== null) throw` through the final `return`).

## 1. Branch fidelity — PASS

Current final-delivery code (interface.ts):

```ts
if (firstSendError !== null) throw firstSendError as Error;
const lastReply = replies[replies.length - 1]?.trim();
if (finishReason === "stop" && text.trim() && text.trim() !== lastReply) {
  persistReply(text); await input.send(text); replies.push(text);
  return { replies, accessed: [...accessed], transcript };
}
if (finishReason !== "stop" || replies.length === 0) {
  log("turn_incomplete", { finish_reason: finishReason, steps });
  persistReply(FALLBACK_MESSAGE); await input.send(FALLBACK_MESSAGE);
  replies.push(FALLBACK_MESSAGE);
}
return { replies, accessed: [...accessed], transcript };
```

Pure fn conditions are byte-identical:
- send: `finishReason === "stop" && trimmed && trimmed !== lastReply`,
  `trimmed = text.trim()`, `lastReply = replies[last]?.trim()`.
- fallback: `finishReason !== "stop" || replies.length === 0`.
- else: `none`.

Matrix mapped to code, exhaustive over `{clean, trimmed-empty, echo, hasReplies}`:

| Row | Inputs | send-if | fallback-if | Action | Matches |
|---|---|---|---|---|---|
| 1 | stop, non-empty non-echo, no replies | T (`!==undefined`) | — | send | ✓ |
| 2 | stop, non-empty non-echo, ≥1 reply | T | — | send | ✓ |
| 3 | stop, echo last, ≥1 | F (`!==` false) | F | none | ✓ |
| 4 | stop, empty text, ≥1 | F (trimmed falsy) | F | none | ✓ |
| 5 | stop, empty text, no replies | F | T (`length===0`) | fallback | ✓ |
| 6 | not stop, any text, any replies | F (not stop) | T (not stop) | fallback | ✓ |

- **Raw vs trimmed confirmed:** guards use `text.trim()`; delivery uses raw
  `text` (`persistReply(text)/send(text)/push(text)`). Pure fn returns
  `text: input.text` raw on send. Bytes preserved.
- **Early-return → else-if confirmed mutually exclusive:** original `return`s
  after send, so the fallback `if` never runs when send fired; when send did not
  fire, the fallback `if` ran. `if (send) … else if (fallback) …` gives the same
  two-way exclusivity, `none` does nothing. No third path, no double send. The
  send branch's own `return` object is identical to the terminal `return`
  (same mutated `replies` reference, same `accessed`/`transcript`).
- **steps / finishReason:** `finishReason` feeds the decision (send + fallback
  conditions). `steps` feeds only the `turn_incomplete` log, not any branch —
  correctly left as a runner side effect, not a pure-fn input.

## 2. Purity / seam — PASS

The three inputs `{finishReason, text, replies}` are sufficient to decide every
branch with no I/O. The tail reads nothing else for the decision: no onboarding
flag, no research flag, no error state. `firstSendError` is consumed by the
re-raise *before* the decision (not an input to it); `accessed`, `transcript`,
`usage`, `steps` do not gate any branch. No blocker here.

## 3. Side effects stay put — PASS

Runner rewrite keeps in the runner: `persistReply`, `input.send`,
`replies.push`, the `turn_incomplete` log (`{ finish_reason, steps }`), and the
`firstSendError` re-raise. The re-raise stays ordered **before**
`decideFinalDelivery(...)`, unchanged — the error path is not moved. Pure fn does
no logging, no send, no push, no mutation. Persist-before-send order preserved
(`persistReply` then `send` in both branches), matching docs/topics.md.

The orchestrator's separate `FALLBACK_MESSAGE` use (`orchestrator.ts:139`,
rate-limit / `turn_failed` boundary) is unrelated to this tail and untouched.

## 4. Preservation — PASS

All 6 rows plus edges preserved: whitespace-only text is treated empty
(`text.trim()` falsy → not send; with replies → none, without → fallback);
echo compares both sides trimmed; empty + no replies → fallback; cap cut-off
(`finishReason !== "stop"`) → fallback regardless of text or replies. Note the
preserved subtlety: a non-`stop` finish that produced non-empty final text still
discards that text and sends the fallback (row 6 "any text"); the extraction
keeps this.

## 5. Tests — PASS with a coverage gap (see concern 1)

Existing full-run `interface.test.ts` cases map to rows 1/2/3/5/6 and
persist-before-send order; row 4 is covered indirectly by the "sends each reply
immediately" / "tracks accessed topics" scripts (reply then `{text:""}` →
clean+hasReplies+empty → none, no fallback appended). These stay unchanged and
remain the wiring/regression guard. The 10 pure cases cover rows 1–6 plus
whitespace-empty, whitespace-echo, and raw-text preservation.

## Findings

### Concern 1 — Row 6 fidelity: pin non-`stop` WITH non-empty text
The behavior "cap cut-off discards a produced final text and sends fallback" is
not pinned by any test. Listed pure cases 8/9 and both full-run cap-cutoff tests
use *empty* final text, so they cannot distinguish "fallback because not stop"
from "fallback because empty + no replies". A later change that sends the
leftover text on a non-`stop` finish would pass the whole suite yet change
behavior. Fix: add a pure case
`decideFinalDelivery({ finishReason: "tool-calls", text: "some answer", replies: [] })`
→ `{ action: "fallback" }` (and optionally with a prior ack reply), proving
`finishReason` drives fallback independent of text content.

### Concern 2 — Echo guard only compares the LAST reply
Preserved from current code (`replies[replies.length - 1]`), but worth an
explicit pure test that `text` echoing a *non-last* earlier reply still sends
(action `send`), so the "last reply only" semantics is locked against a future
"compare against all replies" regression. Not a behavior change in the plan;
add-coverage only.

### Nit 1 — Assert discriminant carries no stray text
Add assertions that `fallback` and `none` decisions are exactly
`{ action: "fallback" }` / `{ action: "none" }` (no `text` field), locking the
"runner owns FALLBACK_MESSAGE" contract.

### Nit 2 — Delete `const lastReply` in runner
Plan already calls this out; confirm the now-unused `const lastReply` line is
removed from the runner (it moves into the pure fn) so lint stays green.

## 6. Changelog — correct

No entry. Extract-and-test refactor, behavior identical, no user-observable
change. Matches AGENTS.md policy.

## Go / No-go

**GO.** The extraction reproduces current behavior exactly across all 6 rows and
the edge cases; inputs are sufficient and pure; side effects and the error
re-raise stay ordered in the runner. Address concern 1 (cheap, strengthens the
row-6 guard) while implementing; concern 2 and the nits are optional hardening.
