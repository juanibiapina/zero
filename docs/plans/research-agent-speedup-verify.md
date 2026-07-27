# Verification — research-agent-speedup plan

Adversarial review of `docs/plans/research-agent-speedup.md`. Goal under review:
take the research agent from ~12 min to 1–2 min **without losing per-claim source
links**. Verdict and the three objections are answered first; evidence and
severity-ranked findings follow.

## Verdict

**Revise before implementing.** The core of the plan is correct and load-bearing:
stripping topic-write tools from the research agent is what actually buys the
speed (it deletes the 7.3 min of in-loop body writes), and a lossless findings
path is genuinely needed to keep source URLs. But the plan **overstates the
`max_tokens` cap as necessary** (the incident does not show what the plan says it
shows), sets **`maxSteps: 15` low enough to risk empty reports**, and **carries
optional scope** (the model-seam `maxTokens` plumbing) that can be deferred
without missing the goal. None of these are hard blockers — the plan would work
as written — but two of them add risk and code for little gain.

---

## Objection 1 — the hard `max_tokens = 2000` cap

**The user is essentially right. The cap is insurance, not the lever, and the
plan's justification for it is not supported by the incident data.**

### What actually happens when a research generation hits `max_tokens` (traced, not assumed)

- `model.ts:146` sends `max_tokens`; a truncated generation comes back with
  `stop_reason: "max_tokens"`.
- `run.ts:123` maps `max_tokens → "length"`. In the loop, `run.ts:250` filters
  the response for `tool_use` blocks; a truncated **final report** has none, so
  `run.ts:263-268` returns the partial `text` (the text blocks produced so far)
  with `finishReason: "length"`.
- `research.ts:79,102` reads `finishReason` **only to log it** (`finish_reason`
  field). The `text` is used regardless — returned as the tool result string
  (today `research.ts:113`, in the new design as `report`).
- The interface agent then reads that tool result as an ordinary tool response.
  Research's `finishReason` is **not** propagated to the interface, so a
  truncated report does **not** trip `decideFinalDelivery`'s
  `finishReason !== "stop"` fallback (`interface.ts:66`) — that guard only sees
  the interface's own run.

**Conclusion:** a truncated report is returned **as-is**. Not retried, not
dropped, no user-facing error, no crash. The failure mode of hitting the cap is
"the report ends mid-sentence," which the plan mitigates by ordering
sourced bullets first. So the user's fear ("it's just going to break/stop") is
half-right: it does stop, but it stops *gracefully*.

### Is the truncation risk real at 600 target / 2000 cap?

Headroom is 3.3x. To hit the cap the model must ignore an explicit "~10 bullets,
under 400 words" instruction by more than 3x. Possible for a rambling model, but
if it happens the output degrades gracefully rather than failing. So the cap's
downside is small — but so is its upside, because:

### Does the incident actually prove the model overruns brevity instructions? No.

The plan asserts "prompt alone is too weak — the incident proves the model
overruns." **The incident proves the opposite for final/summary generations.**
Reading `agent-latency-investigation.md`'s gateway table:

- The three giant generations (7,853 / 7,440 / 5,803 tokens, 117–165 s) are the
  research agent's **`update_topic` body writes** — tool-call steps authoring
  full topic-body markdown, exactly what the current prompt orders ("your
  findings live in the topic you write… create_topic, then fill it with
  update_topic", `prompts.ts` `researchSystemPrompt`).
- Every **non-body** research generation in the same window was **small**: 73,
  377, 57, 401, 75, 494, 180, 160, 358, 57, 430 output tokens. The current prompt
  already says "End … with a short sourced summary," and the model **obeyed** —
  its summary/final generations were all well under 500 tokens (~10 s).

So the model already respects a brevity instruction for its final message. The
5–8k overruns came from the model **doing what it was told** (write the full
body), not from ignoring a length limit. Once change #1 removes the write tools,
those generations cannot exist. What remains — search-query steps and the final
report — is precisely the class the incident shows the model already keeps
small.

**Therefore the max_tokens cap is not what hits the 1–2 min goal; removing the
write tools is.** The cap is cheap belt-and-suspenders insurance against a
pathological long report, with a graceful failure mode.

### Middle option / recommendation

- **Keep a cap, but make it generous enough to never bite in normal operation.**
  A ~600-token report is ~13 s; even 3,000–4,000 tokens (~63–83 s) bounds the
  worst case far below the old 117–165 s while making an accidental chop of a
  legitimately-verbose report near-impossible. At 2,000 the cap sits only 3.3x
  over target and is the most likely of the sane values to clip a real report.
  Recommend **`max_tokens ≈ 4000` for research** (the investigation's own Rank #5
  suggested 2,000–3,000; 4,000 is the same order and safer against clipping).
- **Treat `maxSteps` (a step-level guard) as the primary runaway bound**, not the
  token cap — see Objection 3 / Concern C2. A step guard bounds the *loop*; the
  token cap only bounds one *generation*, and the loop was the 12-minute problem.
- The prompt change plus write-tool removal alone would very likely hit the goal;
  the cap is optional hardening. If you want to cut scope (Objection 3), the cap
  and its model-seam plumbing are the first things to defer.

---

## Objection 2 — interaction with the upcoming shared-cache task

**The two tasks do not materially conflict. This plan's findings placement is
cache-friendly by construction, provided you keep the findings in the writer's
per-turn user message tail (which the plan does) and out of any shared prefix.**

### Where the findings land in the writer's input

Today the writer receives a single user `prompt` string built in
`writer.ts:41-46`: `"# Turn transcript\n\n{transcript}\n\n# Topics accessed…\n\n…Consolidate…"`. The plan appends a `# Research findings` section to the **end**
of that same per-turn user message (plan step 8). The writer's system prompt is
`writerSystemPrompt()`; the writer sets **no** message-region cache breakpoint
today (only `run.ts` caches system+tools).

### Does that defeat a future shared cache prefix?

No. The future task wants a **shared** system prompt and a **shared message
prefix** across interface/research/writer, with **agent-specific instructions
moved later in the message sequence**. The writer's transcript and the research
findings are inherently **turn-specific and agent-specific** — the interface and
research agents never receive "# Research findings" or the writer's transcript,
so this content can never be part of a cross-agent shared prefix. It belongs in
the tail region, which is exactly where the future task wants agent-specific
content to sit. Appending findings after the transcript keeps them after any
future shared prefix. **Cache-friendly by construction.**

### The one real touch-point, and why it is not new rework

The plan also edits `writerSystemPrompt()` (the "Persist research findings"
clause). If the future task unifies the **system prompt** across all three
agents, every writer-specific line in `writerSystemPrompt()` has to move into the
message sequence — the new clause is just one more line in that same wholesale
relocation, not a new category of problem. The plan does not add a *new* place
the future task must untangle; it adds one line to an existing one.

### To be cache-friendly by construction (optional refinement, not required now)

If you want to pre-shape for the caching task, render the findings as a **distinct
trailing user message** rather than string-concatenated into the transcript
prompt. That makes "shared prefix … then agent-specific tail" a clean message
boundary the caching task can breakpoint directly. Minor; the concatenated form
does not block the caching task, it just leaves the split as a string boundary
instead of a message boundary.

**Bottom line:** no conflict, no required rework. Keep findings in the writer's
per-turn tail (as planned); optionally emit them as their own trailing message.

---

## Objection 3 — scope

Enumerated changes, each classified **[goal]** (required for 1–2 min), **[data]**
(required to avoid losing source links), or **[optional]**:

| # | Change | Class | Note |
|---|---|---|---|
| 1 | Model seam: `maxTokens?` on `AgentModelRequest` (`protocol.ts`), `model.ts`, `RunAgentInput`/`run.ts` | **optional** | Only exists to serve the token cap. Not needed for the goal; not needed for provenance. |
| 2 | Strip write tools from research; add `buildTopicReadTools` (list_topics + get_topic) | **[goal]** | THE lever. Deletes the 7.3 min of in-loop body writes. |
| 3 | `ResearchFinding` type + findings channel (research → interface → orchestrator → writer) | **[data]** | Needed so URLs bypass the 1500-char transcript truncation (see below). |
| 4 | `max_tokens = 2000` on the research call | **optional** | Insurance; graceful failure. See Objection 1. |
| 5 | `maxSteps: 15` on research | **optional** (loop guard) | Cheap, but 15 is too low — see C2. |
| 6 | Rewrite `researchSystemPrompt()` to gather-and-report | **[goal]** | Must stop ordering in-loop body authoring. Pairs with #2. |
| 7 | Interface prompt reword ("reads and writes topics" → "looks up and reports") | **optional** | Cosmetic; avoids "saved to topic X" over-promising. |
| 8 | Writer: accept + render findings; rewrite preservation clause | **[data]** | The writer is what actually persists the findings + URLs. |
| 9 | Docs (`research.md`, `topics.md`) | required by repo policy | Not functional. |
| 10 | Changelog | required by repo policy | User-visible change. |
| 11 | Tests | required by policy/quality | — |

### Recommended minimum change set (hits the goal, keeps source links)

- **#2 + #6** — strip write tools, rewrite the research prompt to return a short
  sourced report. This alone gets the latency.
- **#3 + #8** — the lossless findings path + writer persistence. Required so the
  URLs survive (the transcript truncates at 1,500 chars; a ~2,400-char report
  loses its tail sources — see the "necessity" check below).
- **#9 + #10 + #11** — docs, changelog, tests, per repo policy.

### Defer to their own task (or drop)

- **#1 + #4 (model-seam `maxTokens` + the 2000 cap):** defer. Not required for the
  goal; the write-tool removal is the lever, and the incident shows final
  generations were already small. If kept, make the cap generous (~4000) and land
  it as a small separate hardening change so it does not bloat this one. Deferring
  removes three-file plumbing (`protocol.ts`, `model.ts`, `run.ts`) and its test
  from this change.
- **#5 (`maxSteps`):** keep a step cap (it is a one-liner and the loop was the
  real problem), but raise it — see C2. This is cheaper and more on-point than the
  token cap for bounding runaway cost.
- **#7 (interface reword):** trivial; include it or defer it, low stakes either
  way.

---

## Normal verification

### Current-flow trace accuracy (spot-checked file:line)

Accurate, with sub-line drift only:

- `interface.ts` `buildResearchTool` registration: plan says `288-295`; actual
  `290-296` (`buildResearchTool({ model: input.researchModel ?? input.model, …})`
  at 290-291). ✓ substance.
- `research.ts` fallback write: plan says `89-94`; actual `written.size === 0` at
  `88`, fallback body write immediately after. ✓
- `research.ts` accessed merge: plan says `98`; actual `for (const name of
  written) accessed.add(name)` at `97`. ✓
- `research.ts` return string: plan says `107-112`; actual `research_completed`
  log at `100`, return at `113`. ✓
- `run.ts:38` `AGENT_MAX_STEPS = 200`. ✓ `model.ts:52` `MAX_TOKENS = 16000`. ✓
- `buildTopicTools` = list_topics, get_topic, create_topic, update_topic
  (`topics.ts:33,40,70,82`); `buildInterfaceTools` adds reply. ✓
- Writer runs every turn (`orchestrator.ts` `runWriterAgent`). ✓ Transcript tool
  results truncated to `MAX_TOOL_RESULT_CHARS = 1500` (`interface.ts`). ✓

The redesign's core claim — "today source URLs reach storage because research
writes the body and the writer reads the full body via get_topic; the 1500-char
transcript truncation does not hurt provenance today because the writer does not
depend on the transcript for URLs" — is correct.

### Is the findings channel necessary given the 1500-char transcript truncation?

**Yes, if you want a guarantee.** The plan caps the report at ~600 tokens ≈ 2,400
chars, which exceeds `MAX_TOOL_RESULT_CHARS = 1500`. The research tool result
*does* appear in the transcript, but truncated to 1,500 chars, so a report longer
than that loses its trailing bullets — and their `Source:` URLs — before the
writer sees it. So relying on the transcript is lossy for exactly the payload
this plan must preserve.

**But there is a lighter alternative the plan does not weigh:** exempt the
research tool result from truncation (raise or skip `MAX_TOOL_RESULT_CHARS` for
that one tool, or cap the report under ~1,400 chars so it survives whole). That
preserves URLs with a one-spot change instead of a new type threaded through four
layers. The dedicated findings channel is architecturally cleaner (it keeps the
lossy transcript and the lossless findings as distinct seams, which the plan's
own `deep-modules` note calls out) and gives the writer structured `subject`/
`topic` routing, so it is defensible — but it is not the *only* way to avoid data
loss, and a scope-minimizing reviewer should know the cheaper option exists.
Recommendation: keep the findings channel (cleaner, and it carries routing the
writer benefits from), but acknowledge it is a design choice for cleanliness, not
the sole data-loss fix.

### Acceptance criteria objectively checkable?

Mostly yes.

- #1 `store.listTopics()` empty after a scripted research run — checkable. ✓
- #2 URL present in tool result + captured finding — checkable. ✓
- #3 request carries `max_tokens = 2000` and `maxSteps = 15` via `capturingModel`
  — checkable, **but couples the test to the specific numbers**; if you take the
  Objection-1 advice and change the cap (or defer it), this criterion changes with
  it. State the criterion as "research call carries the configured research
  `max_tokens`/`maxSteps`" rather than hard-coding 2000/15.
- #4 writer test lands a URL in the stored body — checkable. ✓
- #5 test/lint/typecheck — checkable. ✓  #6 docs/changelog updated — inspectable. ✓
- #7 production 1–2 min — measurable but non-deterministic (model/network/Brave
  rate-limit dependent); fine as a production check, not a unit gate.
- #8 stored topic contains resolving URLs — checkable via `curl`. ✓

---

## Findings (severity-ranked)

### Blockers

None. The plan is implementable as written and would preserve source links. The
issues below are about unnecessary risk and scope, not correctness.

### Concerns

- **C1 — the plan mis-cites the incident to justify the hard cap.** "The incident
  proves the model overruns [brevity]" is not supported: the 5–8k generations
  were `update_topic` **body writes** (what the prompt ordered), while every
  final/summary generation in the incident was <500 tokens. Evidence:
  `agent-latency-investigation.md` gateway table + `prompts.ts`
  `researchSystemPrompt` ("End … with a short sourced summary"). **Fix:** reframe
  the cap as optional insurance, set it generous (~4000, graceful failure), and
  make the step guard the primary runaway bound. Do not present the cap as what
  achieves the goal.

- **C2 — `maxSteps: 15` is low enough to produce empty reports.** The incident
  research loop ran **20+ steps**. On `maxSteps` exhaustion `run.ts:263-268`
  returns `text: ""` with `finishReason: "tool-calls"`; in the new design that
  yields an **empty `report`** to the interface and an empty finding — worse than
  a truncated one. Removing write tools and fixing the tool substrate will cut
  step count, but a thorough task with several `read_page` calls can still exceed
  15. **Fix:** set `maxSteps` to ~20–25 (top of the investigation's own "12–20"
  range, with headroom), and/or handle an empty/`tool-calls` research result
  explicitly instead of returning an empty report.

- **C3 — scope carries an optional model seam.** Changes #1 and #4
  (`maxTokens` through `protocol.ts` → `model.ts` → `run.ts`, plus the 2000 cap)
  are not required for the 1–2 min goal or for provenance. **Fix:** defer them to
  a small separate hardening change, or land a generous cap only. The minimum set
  is #2, #3, #6, #8 (+ docs/changelog/tests).

### Nits

- **N1 — acceptance criterion #3 hard-codes 2000/15.** Restate as "the configured
  research `max_tokens`/`maxSteps`" so tuning the numbers (per C1/C2) doesn't
  churn the test contract.

- **N2 — the findings channel is presented as the only data-loss fix.** A lighter
  alternative (don't truncate the research tool result in the transcript, or keep
  the report under 1,500 chars) achieves the same provenance guarantee. Keep the
  channel for cleanliness/routing, but note it is a design choice, not a
  necessity.

- **N3 — interface prompt reword (#7) is cosmetic.** Fine to include, but it is
  not load-bearing for either the goal or provenance; do not let it grow.

- **N4 — line citations drift by 1–2 lines** (e.g. `288-295` vs actual `290-296`;
  `98` vs `97`). Substance is correct; tighten if the plan is edited.
