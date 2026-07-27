# Verification — research → writer handoff plan

Reviewer verdict on `docs/plans/research-writer-handoff.md`. Adversarial read
against source, git history, and the companion plans.

## Verdict

**Blockers: none.** The plan is sound and ready for human approval with two
concerns worth folding in first (both cheap). The diagnosis is correct, the
chosen fix is the right lever and is genuinely small, and completeness checks
out: the truncation it fixes is the only clip on the findings→storage path.

- **Diagnosis correct?** **Yes.** Independently confirmed below.
- **Is 8,000 the right ceiling?** Defensible, slightly arbitrary. Fine for the
  observed case; note it caps enumerations at ~50 sourced items (see C1).
- **Is 2,500 the right prompt target?** Yes in direction and magnitude, but the
  "1,115-token generation" it is measured against is unsourced in the referenced
  docs (see C2). The conclusion (2,500 chars stays compact) holds regardless.

## Independent confirmation of the diagnosis — YES, the truncation is ours

Traced the whole path in source, not the plan's word:

- `apps/agent-api/src/tools/research.ts:` `execute` ends `return report;` where
  `report = text || "No findings."` — the findings report, **uncapped**, is the
  `research` tool result string.
- `apps/agent-api/src/agents/interface.ts:125` `MAX_TOOL_RESULT_CHARS = 1500`;
  `:136-139` `truncate` cuts to 1500 and appends `…[truncated]`; `:180-184`
  `renderTranscript` calls `truncate(renderToolResult(block.content))` on **every**
  `tool_result` block, research included.
- `apps/agent-api/src/agents/writer.ts:` `runWriterAgent` passes the transcript
  verbatim into the writer prompt (`` `# Turn transcript\n\n${transcript}...` ``).
- `runAgent` (`run.ts`) hands the tool result to the interface model **uncapped**
  (`serializeOutput` passes strings through); the only clip is in the transcript
  the writer reads. So the interface model answered the user from the full report
  while the writer saw only the first 1,500 chars — exactly the failure shape.

Size math is decisive on its own: `report_len: 3032 > 1500`, so `truncate` fired
by construction. `3032 − 1500 = 1532` chars (~51%) replaced by the marker. The
writer's self-generated "result was truncated" note is a reaction to bytes in its
own prompt, which can only be our marker. **Confirmed: real, ours, not the gateway
viewer.** I did not pull the live gateway body for the 17:51Z turn (no access from
this box), but the three independent lines above already settle it.

## Fix mechanics — verified

- **Tool name is in hand at the clip site.** `interface.ts:178`
  `const name = toolNames.get(block.tool_use_id) ?? "unknown";` sits one line
  above the `truncate` call. Branching on `name === "research"` to pick a higher
  ceiling is a true small local change inside `renderTranscript`. **Confirmed.**
- **Why the 1,500 cap exists.** `git show 5647211` ("Feed the writer the full
  turn transcript…"): the commit that introduced `renderTranscript` with
  per-result truncation, precisely so a full calendar listing or long email body
  could not swell the writer's input. The plan's rationale is accurate. Exempting
  `research` does **not** undermine it — calendar/email keep the 1,500 cap.
- **Writer context budget.** Writer runs the same model; `model.ts:52`
  `MAX_TOKENS = 16000` is the **output** cap, and the input window is Claude's
  ~200k. A worst-case 2 research calls × 8,000 chars ≈ 4k input tokens is trivial
  against 200k and is billed once then cached within the run (see caching). **No
  blowup, no meaningful cost.** (Plan's phrasing conflates the 16k output cap with
  input budget — see N2 — but the conclusion is right.)

## Caching (c9b443a) — verified against code, no disturbance

- `git log c9b443a` confirms the loop-owned **sliding message-region breakpoint**;
  `cache.ts` `slideMessageBreakpoint` marks only the **tail** message each step;
  `run.ts:` the snapshot is re-marked per step, persisted array untouched.
- The writer is invoked with a single `prompt` (`writer.ts`), i.e. one
  per-turn user message that differs every turn. It can never be a shared
  cross-turn/cross-user cached **prefix**. The cached prefix is tools + system
  (`markLastTool` + `cachedSystem`, both 1h), which is size-independent of the
  transcript. Enlarging the research portion only enlarges the writer's own
  message tail — the step-1 write that later steps read back, exactly what
  c9b443a implements. Breakpoint budget unchanged (writer has no cross-turn
  anchor). **Confirmed: no prefix eviction, no breakpoint arithmetic change.**

## Completeness — the only clip on the findings→storage path is the one being fixed

Traced return→storage and grepped every size limit:

- `research.ts` returns `report` **uncapped**.
- `run.ts` `serializeOutput` / `runTool` pass the string through **uncapped** to
  the interface model.
- `renderTranscript` `truncate` — **the clip** (fixed here).
- `writer.ts` passes transcript verbatim; the writer's `get_topic` returns full
  bodies (`rg` found no slice/truncate in `tools/topics.ts`), and the store has
  **no body cap** (`store/db.ts`, `store/memory.ts` — no length guard on writes).

Other `…[truncated]` producers exist but are **off this path**: `prompts.ts:15`
(pinned-topic rendering, read side) and `pagefetch/tavily.ts:41` (page content the
research agent *reads*, upstream of the report). Neither clips the findings on the
way to storage. **The plan fixes the one clip and leaves no second clip.**

## Findings (ranked)

### Concern C1 — the 8,000 ceiling still clips long enumerations, and the new prompt exception pushes toward it

The fix raises the clip threshold (1,500 → 8,000); it does not remove it. The
17:51Z case was ~150 chars/item (3,032 chars / ~20 items), so 8,000 chars ≈ **~50
sourced items** before the clip re-fires. The plan **also** adds a prompt
"enumeration exception" that explicitly invites longer lists. So the two changes
are in mild tension: the prompt says "run longer so no item is dropped," the
ceiling silently drops items past ~50. Fine for the observed shape, but name the
practical limit in the plan and size the ceiling knowing the prompt encourages
growth. If lists beyond ~50 sourced items are plausible (they are, for "all X in a
city"), consider a higher ceiling or fully uncapped for `research` (the plan
already calls uncapped "defensible"). Cheap to decide now.

### Concern C2 — the "1,115-token generation measured as good" anchor is unsourced, and the two docs disagree on chars/token

`rg "1,115|1115"` finds the number **only in this plan**, not in
`research-agent-speedup.md` or `agent-latency-investigation.md`. The speedup doc
instead targets **~600 tokens ≈ ~1,500 chars** (line 139: "at ~48 tok/s a
600-token final generation is ~13s"). That implies ~2.5 chars/token, while this
plan's own figures (3,032 chars ≈ ~800 tokens) imply ~3.8 chars/token and its
"2,500 chars ≈ ~600 tokens" implies ~4.2. The direction is fine — 2,500 chars is
compact under any of these ratios — but the specific "safely under 1,115 tokens"
claim rests on a number not in the cited verification. Either source it from the
production log for that turn or drop it and anchor to the speedup doc's own
~600-token/~13s good case. Does not change the recommendation.

### Concern C3 — the enumeration exception's only latency guard is the prompt; the real guard (max_tokens) is deferred

`rg` confirms `research.ts` calls `runAgent` with **no** `maxTokens` — the
speedup plan's `maxTokens: 2000` ceiling never shipped. So today report length is
bounded only by the prompt and `RESEARCH_MAX_STEPS = 40`. Adding a prompt
exception that permits longer enumerations, with no hard output ceiling, means a
pathological enumeration can produce a long, slow final generation governed purely
by a soft instruction. The plan flags this and marks max_tokens "optional, if
cheap" (step 7). Recommend promoting it to **in-scope**: wiring `maxTokens` (e.g.
~1,200 tokens, comfortably above the 2,500-char target) is the durable latency
guard and directly backstops the exception you are adding. Small model-seam change
already fully specified in `research-agent-speedup.md` steps 148-155.

### Concern C4 — acceptance criterion 6 tests the LLM writer's output, not the code change

Criterion 6 requires "the stored topic's item count equals the report's item
count." The code change guarantees the writer's **input** is complete; it cannot
guarantee the writer **persists** every item — that depends on the writer LLM
honoring the reworded "persist verbatim" prompt, which is probabilistic. Split the
criterion: (a) objectively checkable — the writer's gateway request body has no
`…[truncated]` in the `Tool result research:` section and ends on the report's
real final line (this is what the code change actually guarantees); (b) soft
observation — stored item count tracks the report. Keep (a) as the pass/fail gate.

### Nit N1 — the `…[truncated]` marker is not globally unique

The plan says the marker is produced by "exactly one code path that touches tool
results." True as qualified, but the literal `…[truncated]` also comes from
`prompts.ts:15` and `pagefetch/tavily.ts:41`. Lead the proof with the size math
(`3032 > 1500`, clip fires by construction), which is unqualified, and keep the
marker as corroboration. No change to the conclusion.

### Nit N2 — context-budget paragraph conflates output max_tokens with input budget

"Runs on the same 16k-max_tokens … model, so a few thousand extra characters is
small" — 16k is the **output** cap (`model.ts:52`); the reason a few thousand
input chars are safe is the ~200k **input** window plus within-run caching.
Reword so the justification names the right limit.

### Nit N3 — unit tests cover the branch; confirm the existing non-research test stays

The proposed `renderTranscript` tests (research over 1,500 not clipped; research
over 8,000 clipped at ceiling; boundary just under; non-research still clipped)
directly exercise the new branch and are pure/unit-testable — `renderTranscript`
is exported and already unit-tested (`interface.test.ts:~952` truncates a 5,000-
char `get_topic` result). Keep that test as the non-research case; it already
asserts `…[truncated]`. Tests are adequate.

## Unblocked to proceed

No blockers. Fold C1–C4 into the plan (C3 ideally into the same change), tidy the
two nits' wording, and it is ready for approval. Diagnosis: **confirmed real and
ours.** Ceiling and prompt target: **right in direction**; pin the ceiling with
the enumeration limit in mind (C1) and source or drop the 1,115-token anchor (C2).
