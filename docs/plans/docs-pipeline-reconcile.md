# Plan: reconcile docs/research.md and docs/topics.md with the current pipeline

## Goal

Four commits landed today changed the research → writer → topics pipeline and
the turn's caching and typing behavior:

- **131a7f0** — the research agent lost `create_topic`/`update_topic`. It now
  returns a sourced findings report and the writer persists it. `RESEARCH_MAX_STEPS = 40`.
- **c9b443a** — every agent's tool loop owns a sliding message-region cache
  breakpoint (research previously had none).
- **69452b1** — the Telegram typing indicator stops when the reply is sent,
  before the writer runs.
- **00759b8** — research tool results get an 8,000-char ceiling in the writer's
  transcript; other tools keep 1,500. The research prompt target was relaxed to
  ~2,500 chars with an enumeration exception.

`docs/research.md` and `docs/topics.md` were already partly updated for the
131a7f0 narrative (they describe research as no-write gather-and-report and the
writer as the persister). But four concrete claims are now false or misleading,
and one sibling doc (`docs/onboarding.md`) still asserts research authors a
topic. This plan lists every false statement with a file:line citation and the
current truth, then specifies the exact edits. These are internal docs; their
job is to give the next reader (human or agent) a correct mental model, so the
edits prioritize the flow and the constraints (which agent writes, what the
char ceilings are, when typing stops) over prose.

`docs/caching.md` was checked and is **already accurate** for c9b443a: it
describes the loop-owned sliding tail breakpoint and states that research/
writer/onboarding now get tier-4 message-region caching. No caching.md edit is
needed beyond an optional one-clause pointer from research.md (see below).

## Production numbers (fact, to include)

Measured on the verified 17:51Z research turn:

- Research phase: **48s over 6 steps**.
- Largest single generation: **1,115 tokens**.
- Whole turn (interface + research + writer): **88s**.
- Turn cost: **$0.217**.
- Pre-fix incident baseline (research authoring full topic bodies in-loop):
  **~12 minutes, $3–4 per turn**.

State these as measured fact, not aspiration.

## The one honest caveat (verified vs expected)

- **Verified:** the code path — research tool results are clipped at
  `MAX_RESEARCH_RESULT_CHARS = 8000` and every other tool result at
  `MAX_TOOL_RESULT_CHARS = 1500` (`interface.ts`); the 48s/6-step/88s/$0.217
  speedup above.
- **Expected but not yet observed:** the *post-fix* behavior of the 8,000-char
  ceiling on a real research turn — i.e. an actual research report longer than
  1,500 chars reaching the writer whole. The 17:51Z verification predates the
  ceiling change on a real long report. Docs must say the ceiling is in place
  and why, and that it is **not yet confirmed in production**, not claim it was
  verified live. (`docs/plans/research-writer-handoff-verify.md` calls the
  8,000 threshold "defensible, slightly arbitrary" and notes the 1,115-token
  anchor is unsourced outside that plan.)

## False / misleading statement inventory

### 1. research.md:14–15 — report size and truncation numbers (both wrong)

> "asks for a compact report (~1,200 characters) so it survives the interface
> transcript's per-tool-result truncation (1,500 chars) intact and its sources
> reach the writer."

Both numbers are stale **and the mechanism is inverted**.

- Prompt target is now **~2,500 chars**, with an explicit enumeration exception
  that lets the report run longer rather than drop sourced items
  (`agents/prompts.ts:178`, `:181-184`; comment `:144-148`).
- Research tool results are no longer bounded at 1,500 in the transcript. They
  get a dedicated **8,000-char ceiling** (`agents/interface.ts:143`
  `MAX_RESEARCH_RESULT_CHARS = 8000`, applied at `:210-214`); only non-research
  tools keep 1,500 (`interface.ts:139` `MAX_TOOL_RESULT_CHARS = 1500`).
- The old story ("keep the report tiny so it fits under 1,500") is reversed:
  the ceiling was **raised to fit the report**, so the report can carry every
  claim and Source URL to the writer intact.

**Truth:** the prompt asks for ~2,500 chars (enumerations may exceed it), and
the writer transcript clips research results at 8,000 chars (vs 1,500 for other
tools) so a normal sourced report — and its per-claim `Source:` URLs — reaches
the writer whole.

### 2. research.md:54 — runAgent caching description is incomplete (c9b443a)

> "`runAgent` also applies prompt caching: it sends `system` as a text block
> with a cache breakpoint and marks the last tool with another, and returns
> token counts"

This omits the loop-owned sliding message-region breakpoint added in c9b443a:
`runAgent` now marks the last message of a per-request snapshot before every
step (`agents/run.ts:191-193` calling `slideMessageBreakpoint`, `agents/cache.ts`).
Research previously had no message-region caching and now does. Not false, but
incomplete for a reader trying to understand why research got cheaper.

**Truth:** `runAgent` marks system + last tool **and** advances a sliding
breakpoint over the growing message tail each step, so even the prompt-only
research/writer agents cache their message region within a run. Minor: add a
half-sentence and defer detail to caching.md (which already covers it).

### 3. topics.md:133–134 — blanket "cap each tool result (~1.5 KB)" (00759b8)

> "The interface agent builds it from the run's generated messages
> (`renderTranscript`), capping each tool result (~1.5 KB) so a large payload
> cannot blow up the writer's input"

False as a blanket statement. `renderTranscript` uses a per-tool ceiling:
research results get 8,000 chars, everything else 1,500 (`interface.ts:139`,
`:143`, `:210-214`).

**Truth:** each tool result is capped for the writer's input — non-research
tools at ~1.5 KB (1,500 chars), research reports at 8,000 chars because a
research report is the payload the writer must persist verbatim (every claim +
Source URL), not context it samples from.

### 4. topics.md:214 — typing spans the whole turn (69452b1)

> "A self-rescheduling `setTimeout` re-sends the Telegram typing action every 4s
> while a turn runs; the DO alarm stays dedicated to turn scheduling."

Misleading now. Typing stops the moment the reply is sent, **before the writer
runs** — the writer is internal topic consolidation the user is not waiting on
(`agents/orchestrator.ts:28-34`, `:113-115`; `UserDO/index.ts:197-199`, `:224`;
`TYPING_INTERVAL_MS = 4000` at `UserDO/index.ts:34`). On the failure path typing
stops right after the fallback is sent (`orchestrator.ts:154-156`).

**Truth:** the typing action re-sends every 4s across the interface phase
(including any research the user genuinely waits on) and stops when the reply
(or fallback) is sent, before the writer's consolidation runs.

### 5. onboarding.md:53–54 — "the research agent authors its topic" (131a7f0)

> "It authors the pinned topic directly, like the research agent authors its
> topic, so there is no writer pass."

The analogy is now false: the research agent authors **no** topic — it has no
write tools and returns a findings report the writer persists (`tools/research.ts`,
131a7f0). Onboarding still authors its topic directly and still has no writer
pass, so the point about onboarding stands; only the research comparison is
stale.

**Truth:** rephrase to compare onboarding's direct authoring against the general
"no separate writer pass" idea, dropping the claim that research authors a topic
(e.g. "it authors the pinned topic directly in one pass, with no separate writer
agent").

## Statements checked and found accurate (no edit)

To bound scope, these were verified against source and are correct:

- research.md — no-write-tools narrative, findings-report tool contract,
  `Source:` inline requirement, `RESEARCH_MAX_STEPS = 40`, the `runAgent`
  signature and return shape, read_page/web_search port descriptions.
- topics.md:149–158 — research gather-and-report, writer persists from the
  transcript, "preserve research findings and their reference URLs verbatim,"
  the merged-`accessed` handoff. Matches `writerSystemPrompt` (`prompts.ts:288-296`).
- caching.md — already describes the c9b443a sliding tail and research tier-4
  caching. **No edit.**
- design.md:104–131 — "whose final message becomes the tool result" and
  "research, writer, onboarding still use the single-`prompt` path" are correct.
  **No edit.**
- AGENTS.md:127 — "returns its final message." Correct. **No edit.**

## Planned edits

### docs/research.md

- **Rewrite the intro sentence (lines 14–15).** Replace the ~1,200-char /
  1,500-char truncation claim with: the prompt targets ~2,500 chars (with an
  enumeration exception that may exceed it), and the writer transcript clips
  research results at 8,000 chars (vs 1,500 for other tools) so a normal sourced
  report reaches the writer whole. Keep the causal point that this is what lets
  every claim + Source URL survive to the writer.
- **Extend the `runAgent` caching sentence (line 54).** Add a half-clause: it
  also advances a sliding breakpoint over the growing message tail each step, so
  even prompt-only agents cache their message region within a run; defer detail
  to caching.md.
- **Optional:** where the doc lists the three agents as "the same runner," note
  research now benefits from message-region caching (previously it had none).
  Keep it to one clause; caching.md is the reference.
- **Stays:** the whole "gather-and-report," tool-contract, proactive-triggering,
  web-search/page-fetch, upgrade-paths, and e2e sections are correct as written.

### docs/topics.md

- **Fix the writer transcript cap (lines 133–134).** Change "capping each tool
  result (~1.5 KB)" to the split ceiling: non-research tools ~1.5 KB, research
  reports 8,000 chars, with the one-line reason (a research report is the
  payload the writer persists verbatim, not sampled context). This can reuse the
  wording already in `interface.ts:141-146`.
- **Fix the typing sentence (line 214).** State that typing re-sends every 4s
  across the interface phase (including research) and stops when the reply/
  fallback is sent, before the writer's consolidation. Optionally cross-link the
  orchestrator's `stopTyping` seam.
- **Stays:** the topic model, links, pinned/system topics, two-phase turn,
  research paragraph (149–158), execution/alarm, storage seam, and LLM-access
  sections are correct. The `~1.5 KB` at line 60 is the **pinned-body** prompt
  cap, unrelated to the transcript cap — leave it.

### docs/onboarding.md

- **Fix lines 53–54.** Drop "like the research agent authors its topic"; keep
  the true point that onboarding authors its topic directly with no separate
  writer pass. In scope for this change because it is a direct residue of the
  same 131a7f0 commit and is a one-line fix; leaving it contradicts the
  reconciled research/topics docs.

## Changelog

None. All four commits' user-facing effects (faster research, typing stops
sooner) are internal-docs reconciliation here; the code changes already shipped.
Per AGENTS.md, doc-only reconciliation of internal docs gets no changelog entry.

## Skills to use

- **code** — when applying the doc edits.
- **git-commit** — when committing.

## Acceptance criteria

- research.md no longer mentions "~1,200 characters" or a 1,500-char research
  truncation; it states the ~2,500-char prompt target (with enumeration
  exception) and the 8,000-char transcript ceiling for research vs 1,500 for
  other tools.
- research.md's `runAgent` caching sentence acknowledges the per-step sliding
  message-region breakpoint (defers detail to caching.md).
- topics.md's writer section states the split transcript ceiling (1,500 other /
  8,000 research), not a blanket ~1.5 KB.
- topics.md's typing sentence says typing stops when the reply is sent, before
  the writer runs.
- onboarding.md no longer claims the research agent authors a topic.
- The production numbers (48s/6 steps research, 1,115-token largest generation,
  88s turn, $0.217, ~12 min / $3–4 baseline) appear as fact where the docs
  motivate the no-write design.
- The 8,000-char ceiling is described as in place with its rationale and marked
  **not yet observed on a real research turn**, not as production-verified.
- No edits to caching.md, design.md, or AGENTS.md (verified already accurate).
- `git grep -n "1,200 char"` and `git grep -n "authors its topic"` return
  nothing in docs/.
