# Verification — docs-pipeline-reconcile plan

Adversarial review of `docs/plans/docs-pipeline-reconcile.md`, checked against
current source (`prompts.ts`, `interface.ts`, `run.ts`, `cache.ts`,
`orchestrator.ts`, `UserDO/index.ts`, `tools/research.ts`,
`agents/onboarding.ts`), the four commits (131a7f0, c9b443a, 69452b1, 00759b8),
and the prior verification records. This is the only gate before the edit, so
the bar is: every doc the plan touches ends up TRUE, and every doc it declares
accurate really is.

## Verdict

**Revise before implementing.** The core is right and should proceed: all five
claimed-stale statements are genuinely stale/misleading, and the plan's stated
corrections are accurate against source. But two things must change first:

1. **Blocker — the "production numbers" are presented as measured fact but are
   unsourced in the evidence the plan cites** (1,115 tokens was already flagged
   unsourced by a prior verification; 48s / 6 steps / 88s / $0.217 appear in no
   verification record, and the 17:51Z turn's own verification explicitly did
   not pull gateway timing/cost). Writing these into a doc "as fact" is exactly
   the durable error the task warns against.
2. **Blocker — the plan misses two docs carrying the identical misleading typing
   phrasing it fixes in topics.md, and affirmatively declares one of them
   (design.md) accurate and off-limits.** `framework.md:130` and `design.md:27`
   both say the typing action runs "while a turn runs."

Neither touches the correctness of the five doc fixes; fix the numbers and the
typing-doc scope and the plan is sound.

---

## The five claimed-stale statements — explicit yes/no

Each verified independently: doc line quoted, source quoted, plan's correction
checked.

### 1. research.md:14–15 (report size + truncation) — **YES, stale. Correction accurate.**

Doc: *"asks for a compact report (~1,200 characters) so it survives the
interface transcript's per-tool-result truncation (1,500 chars) intact and its
sources reach the writer."*

Source:
- `prompts.ts:178` — *"Return a compact markdown report: aim for roughly 2,500
  characters or less for prose findings."* plus `:181` enumeration exception.
  Comment `:144` — *"compact report (~2,500 chars) … Research tool results carry
  a generous transcript ceiling (see MAX_RESEARCH_RESULT_CHARS in
  interface.ts)."*
- `interface.ts:125` `MAX_TOOL_RESULT_CHARS = 1500`; `:133`
  `MAX_RESEARCH_RESULT_CHARS = 8000`; `:184`
  `name === "research" ? MAX_RESEARCH_RESULT_CHARS : MAX_TOOL_RESULT_CHARS`.

Both numbers are stale (1,200→2,500; research no longer clipped at 1,500) and the
mechanism is inverted (the ceiling was raised to fit the report, not the report
shrunk to fit the ceiling). Plan's correction is correct.

### 2. research.md:54 (runAgent caching) — **YES, incomplete/misleading. Correction accurate.**

Doc: *"`runAgent` also applies prompt caching: it sends `system` as a text block
with a cache breakpoint and marks the last tool with another, and returns token
counts."*

Source: `run.ts:238` `slideMessageBreakpoint(messages)` is called on a
per-request snapshot **every step** (import `run.ts:25`; helper `cache.ts`
`slideMessageBreakpoint`). The doc omits the loop-owned sliding message-region
breakpoint added by c9b443a, which is precisely why research got cheaper. Plan's
half-sentence addition (advance a sliding breakpoint over the growing tail each
step; defer detail to caching.md) is accurate.

### 3. topics.md:133–134 (blanket ~1.5 KB cap) — **YES, false as a blanket. Correction accurate.**

Doc: *"capping each tool result (~1.5 KB) so a large payload cannot blow up the
writer's input."*

Source: `interface.ts:184` splits the ceiling by tool name — research 8,000,
everything else 1,500. The blanket claim is false. Plan's split-ceiling wording
(non-research ~1.5 KB, research 8,000 because it is the payload the writer
persists verbatim) is correct.

### 4. topics.md:214 (typing spans the turn) — **YES, misleading. Correction accurate.**

Doc: *"A self-rescheduling `setTimeout` re-sends the Telegram typing action every
4s while a turn runs; the DO alarm stays dedicated to turn scheduling."*

Source: `orchestrator.ts:115` calls `stopTyping()` after the interface phase and
**before** `runWriterAgent`; `:156` stops it on the failure path right after the
fallback send. `UserDO/index.ts:34` `TYPING_INTERVAL_MS = 4000`; the `runTurn`
comment states the orchestrator stops the loop "the moment the reply is sent
(before the writer phase)." So typing does not span the writer phase. Plan's
correction (re-sends across the interface phase incl. research, stops when the
reply/fallback is sent, before the writer) is correct.

### 5. onboarding.md:53–54 ("research agent authors its topic") — **YES, stale. Correction accurate.**

Doc: *"It authors the pinned topic directly, like the research agent authors its
topic, so there is no writer pass."*

Source: `tools/research.ts:76` hands research only `{ list_topics, get_topic }` +
web_search + read_page — no write tools; it returns a findings report (131a7f0).
So "the research agent authors its topic" is false. Onboarding still authors
directly (`agents/onboarding.ts:52` `update_topic` fills the pre-created pinned
topic) with no writer pass, so that half stands. Plan's fix (drop the research
comparison, keep the direct-authoring/no-writer-pass point) is correct.

---

## Docs the plan declares accurate — spot-check

- **caching.md — confirmed accurate.** It describes the loop-owned sliding tail
  as tier-4 (breakpoint layout item 4, `slideMessageBreakpoint`) and states
  research/writer/onboarding "get tiers 1-2 … but the loop's sliding tail
  breakpoint (tier 4) now caches their growing message region too." Matches
  c9b443a and `cache.ts`/`run.ts`. No edit needed. ✓
- **design.md:104–131 — the part the plan checked is accurate.** "whose final
  message becomes the tool result" and "research, writer, and onboarding agents
  still use the single-`prompt` path" match `research.ts`/`writer.ts` and
  `run.ts`. ✓ **But see Blocker 2: the plan declared the *whole* doc accurate
  and off-limits, and design.md:27 (outside 104–131) is stale.**
- **AGENTS.md:127 — accurate.** "spawns the research agent with web search … and
  returns its final message" matches the tool contract (research returns its
  final message as the tool result). ✓

---

## Findings (severity-ranked)

### Blocker B1 — the production numbers are unsourced but presented as measured fact

The plan's "Production numbers (fact, to include)" section and acceptance
criteria elevate five figures to shipped-doc fact: **48s over 6 steps, 1,115
tokens, 88s whole turn, $0.217, ~12 min & $3–4 baseline**, all attributed to
"the verified 17:51Z research turn." Checked against every plan/verification in
`docs/plans/`:

| number | status | evidence |
|---|---|---|
| ~12 min baseline | **sourced (rounding)** | `agent-latency-investigation.md`: research loop "~10+ minutes"; speedup plan uses "~12 minutes." Defensible as a round number, but it is the *research loop*, not a clean 12. |
| $3–4 baseline | **sourced** | `agent-latency-investigation.md`: "Cost for this single turn's visible window ≈ **$3–4**." ✓ |
| 1,115 tokens (largest generation) | **UNSOURCED — already flagged** | `research-writer-handoff-verify.md` C2: *"`rg '1,115\|1115'` finds the number only in this plan, not in `research-agent-speedup.md` or `agent-latency-investigation.md`"* and directs the author to *"source it from the production log for that turn or drop it."* Never sourced. |
| 48s / 6 steps | **UNSOURCED** | "48s" appears only as "the 48-second research loop" in `research-writer-handoff.md` with no measurement behind it (and risks conflation with the "~48 tok/s" generation *rate* in `research-agent-speedup.md:139`). "6 steps" appears in **no** doc except this plan. |
| 88s / $0.217 | **UNSOURCED** | Appear in **no** doc except this plan; no verification record contains them. |

Compounding this: the 17:51Z turn's own verification says outright *"I did not
pull the live gateway body for the 17:51Z turn (no access from this box)"*
(`research-writer-handoff-verify.md`), and the only 17:51Z figure it did
establish is `report_len = 3,032` chars / ~20 items — a report **size**, not a
timing, step count, or cost. So the plan's cited evidence base does not contain
the timing/step/cost numbers it labels "measured," and one cited doc explicitly
says that data was not retrievable. The plan even acknowledges the contradiction
in its own honesty section ("notes the 1,115-token anchor is unsourced outside
that plan") while still listing 1,115 as a fact to write.

Per the task's own warning ("a wrong number written as fact into a doc is a
durable error"), this is a blocker. **Fix (either):**
- Pull the actual AI Gateway log for the 17:51Z turn (or a fresh post-fix
  research turn) and cite it in the plan, so the numbers rest on ground truth;
  **or**
- Drop the precise unsourced figures from the doc edits. The docs do not need
  them to motivate the no-write design — research.md already motivates it with
  the sourced "5-8k output tokens per write, minutes of wall clock." Keep the
  sourced baseline (~12 min, $3–4) and the qualitative before/after; omit
  48s/6 steps/1,115/88s/$0.217 until sourced.

The safe default is to drop them; do not ship a number the plan itself admits is
unsourced.

### Blocker B2 — two docs carry the same misleading typing phrase the plan fixes, and one is declared accurate

The plan flags topics.md:214's "*while a turn runs*" as misleading (Claim 4) and
fixes it. The identical phrase lives verbatim in two more docs the plan does not
list:

- `framework.md:130` — *"A self-rescheduling `setTimeout` drives the Telegram
  typing action **while a turn runs**; the alarm stays dedicated to turn
  scheduling."*
- `design.md:27` — *"A self-rescheduling `setTimeout` drives the Telegram typing
  action **while a turn runs**."*

Both are stale by the plan's own standard (typing now stops before the writer
phase, 69452b1). Worse, the plan affirmatively lists design.md under "Statements
checked and found accurate (no edit)" and its acceptance criteria bar edits to
design.md — but the plan only inspected design.md:104–131 and never looked at
design.md:27. This is the "wrongly declared accurate" case the task calls out as
worse than a flagged one: nobody will look again.

**Fix:** either add framework.md:130 and design.md:27 to the edit list with the
same correction as topics.md:214, or, if the plan judges the terse summary
phrasing acceptable in overview docs, say so explicitly and narrow the "design.md
accurate" claim to the section actually checked. Do not leave design.md declared
globally accurate while it contains the exact phrase being fixed elsewhere.

### Concern C1 — "measured fact, not aspiration" framing overreaches

Beyond the specific numbers (B1), the section header "State these as measured
fact, not aspiration" is itself the risk. Even the honest-caveat section of the
plan is correct that the 8,000-char ceiling is not yet observed on a real turn
(verified below), which sits in direct tension with presenting timing/cost from
that same unobserved-post-fix turn as "measured." Align the framing: what is
measured (report size, the baseline incident) vs. what is code-verified but not
yet observed (the ceiling, the post-fix timing). Folding B1 fixes this.

### Nit N1 — line citations drift in interface.ts and run.ts

The plan cites `interface.ts:139` / `:143` / `:210-214` and `run.ts:191-193`.
Actual: `interface.ts:125` (`MAX_TOOL_RESULT_CHARS`), `:133`
(`MAX_RESEARCH_RESULT_CHARS`), `:184` (the per-tool branch); `run.ts:238`
(`slideMessageBreakpoint` call). The named constants/functions are unique, so an
implementer will land correctly, but tighten the numbers if the plan is edited.
prompts.ts (`:178`, `:181`, comment `:144`) and orchestrator.ts (`:115`, `:156`)
citations are accurate.

### Nit N2 — "~12 min" is a rounding of "~10+ min research loop"

The baseline is sourced but the underlying evidence says "~10+ minutes" for the
research loop and "~15 minutes" for the user's total wait. "~12 min" is a fair
round number; just be aware it is not a crisp measurement, and phrase it as
"about ten-plus minutes" or cite which figure it stands for.

---

## The honesty caveat — confirmed correct

The plan says the 8,000-char ceiling is **code-verified** (the path in
`interface.ts` is real) but **not yet observed on a real production turn** (no
actual >1,500-char report has reached the writer whole since the ceiling
shipped). Confirmed:
- The ceiling (00759b8) shipped *after* the 17:51Z incident; on that turn the
  report was clipped at 1,500 (pre-ceiling), which is what motivated the fix.
- `research-writer-handoff-verify.md` explicitly did not pull the live gateway
  body for that turn and calls the 8,000 threshold "defensible, slightly
  arbitrary."

So no post-fix real turn has exercised the ceiling. The caveat is accurate and
should stay — it is the model of honesty the numbers section (B1) fails to meet.

---

## Confirmation / correction of the five numbers

- **~12 min baseline** — sourced (rounding of "~10+ min research loop"); keep, phrase carefully (N2).
- **$3–4 baseline** — sourced; keep.
- **1,115 tokens** — **unsourced; prior verification told the author to source or drop.** Do not write as fact.
- **48s / 6 steps** — **unsourced;** "48s" has no measurement and "6 steps" appears nowhere else. Do not write as fact.
- **88s / $0.217** — **unsourced;** appear only in this plan. Do not write as fact.

Source them from the actual gateway log for a real research turn or drop them.

## Anything the plan missed

- **framework.md:130** and **design.md:27** — the "typing … while a turn runs"
  claim in two docs the plan does not list (Blocker B2).
- No other stale statements found. Grepped docs/ + AGENTS.md for research tools,
  what research returns, topic writing, typing, tool-result truncation, cache
  breakpoints, step caps (`RESEARCH_MAX_STEPS = 40` in research.md matches
  `tools/research.ts` ✓), model choice (no doc claims a faster/Haiku research
  model; MODEL_ID is single ✓), and turn timing. The five listed statements plus
  the two missed typing docs are the complete set.

## Bottom line

The five doc corrections are correct and should proceed as written. Before
implementing: (B1) source or drop the unsourced production numbers, and (B2) add
framework.md:130 + design.md:27 to the typing fix (or narrow the "design.md
accurate" declaration). Fold N1/N2 wording. The honesty caveat is right and
should stay.
