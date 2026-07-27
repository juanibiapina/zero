# Research → writer handoff — stop truncating findings before the writer sees them

Status: plan only (no code changes). Companion to
`docs/plans/research-agent-speedup.md` (the speedup that shipped as commit
`131a7f0`) and `docs/plans/agent-latency-investigation.md` (the incident).
Read those first for context.

## Goal

Make the research agent's full sourced findings reach the writer agent intact,
so every enumerated item and every `Source:` URL is persisted into the durable
topic. Today the findings are clipped to 1,500 characters before the writer
reads them, and the writer stores only what survived the clip.

## Settled diagnosis — real truncation in our code, not a display artifact

**It is explanation (a): our own code truncates the research report to 1,500
characters in the transcript the writer receives.** Not the AI Gateway log
viewer.

### The shipped flow (after commit `131a7f0`)

The speedup landed, but **not** with the dedicated untruncated findings channel
that `research-agent-speedup.md` proposed. What actually shipped routes the
report through the lossy transcript:

1. `apps/agent-api/src/tools/research.ts` — the research tool runs the research
   agent and `return report;` (the agent's final text). That string is the
   `research` **tool result**.
2. `apps/agent-api/src/agents/interface.ts` `renderTranscript` serializes the
   interface run's messages. For every `tool_result` block it calls
   `truncate(renderToolResult(...))`, and `truncate` (interface.ts:137-139)
   cuts to `MAX_TOOL_RESULT_CHARS = 1500` and appends the literal `…[truncated]`.
3. `apps/agent-api/src/agents/writer.ts` passes that transcript verbatim into the
   writer's user prompt: `` `# Turn transcript\n\n${transcript}\n\n...` ``.

So the research report, when longer than 1,500 chars, reaches the writer as
`<first 1500 chars>…[truncated]` — exactly what the writer saw.

### Proof it is ours, not the gateway viewer

- **The marker is our fingerprint.** The exact string `…[truncated]` (Unicode
  ellipsis U+2026 immediately followed by `[truncated]`) is produced by exactly
  one code path that touches tool results: `truncate` at interface.ts:138.
  (`rg "\[truncated\]"` finds it only in our own `truncate`/`slice` helpers.)
  The gateway log viewer's own truncation is a **display** overlay on the
  rendered log; it does not rewrite the request body we sent, and it does not
  emit our `…`-prefixed literal.
- **A model can only react to bytes in its input.** The writer *generated* the
  text "List may be incomplete — research result was truncated." A model cannot
  see the gateway viewer; it can only respond to the bytes in its own prompt.
  The writer reacted to a `…[truncated]` marker, so that marker was in the
  request body we sent — i.e. ours.
- **The size math forces the clip.** The turn logged `report_len: 3032`, and
  `3032 > 1500`, so `truncate` fired by construction.
- **Confirming step if ever doubted:** pull the writer's actual gateway request
  body for that turn; its `# Turn transcript` section ends
  `…CineStar Kulturbrauere…[truncated]`. The `…[truncated]` suffix is our literal;
  the request body is what we sent, so it reflects reality, not the viewer.

The code path, the logged `report_len`, and the writer's own reaction each
independently settle it; together they are conclusive.

### What was lost on the 17:51Z turn

The report was **3,032 characters**; the transcript kept the first **1,500** and
replaced the remaining **1,532 characters (~51%)** with `…[truncated]`. The
research prompt orders "sourced claims FIRST, one/two-sentence summary LAST," so
the surviving half was the leading bullets and the dropped half was the trailing
bullets **plus the summary line**. Concretely the writer stored **14 of ~20
cinemas** — roughly **6 cinemas and their inline `Source:` URLs never reached the
writer** and so never reached storage, and the writer flagged the gap itself.
The provenance for the dropped items is gone, not merely reformatted.

## Options considered

### Option 1 — exempt research tool results from the 1,500-char cap (recommended)

`renderTranscript` already resolves each tool_result's tool name via its
`toolNames` map (interface.ts). Skip truncation (or apply a much higher,
research-specific cap) when the tool name is `research`; keep the 1,500 cap for
every other tool.

- **Pro:** targeted at the one tool output the writer must persist verbatim with
  URLs. Small, local change — the name is already in hand at the truncation site.
- **Pro:** preserves the guard's purpose for calendar/email dumps, which is why
  the cap exists (see rationale below).
- **Con:** the writer's per-turn input grows by the report size on research
  turns. Bounded (see context budget) and mitigated by a generous research-side
  cap rather than fully unlimited.

### Option 2 — dedicated labelled findings channel (the original speedup plan)

Thread a `ResearchFinding[]` from the research tool → interface result →
orchestrator → writer, rendered into a `# Research findings` prompt section,
untruncated, separate from the transcript.

- **Pro:** architecturally clean; findings never touch the lossy transcript;
  this is what `research-agent-speedup.md` specified.
- **Con:** materially larger change (new type, four-hop threading, new writer
  prompt section, more tests) for a benefit Option 1 already delivers. The
  transcript is *already* a labelled channel — the writer reads
  `Tool result research: <report>` and the research-preservation clause keys off
  it — so the "dedicated channel" mostly buys separation we effectively have by
  tool name.

### Option 3 — raise the cap for all tool results

- **Pro:** one-line change.
- **Con:** blunt. It reintroduces exactly the blow-up the cap was added to
  prevent (commit `5647211` added `renderTranscript` with per-result truncation
  precisely so a full calendar listing or long email body could not swell the
  writer's input). Wrong lever.

## Recommendation — Option 1

Exempt research results from the general cap, applying a **generous
research-specific ceiling (~8,000 chars)** rather than removing the bound
entirely. Reasoning:

- The name-resolution seam already exists at the truncation site, so the change
  is small and stays inside `renderTranscript`.
- Research reports are the specific tool output that must survive verbatim with
  provenance; other tool results are supporting context where lossy truncation
  is correct. Option 1 fixes the real need without loosening the guard for
  calendar/email (Option 3's flaw).
- It avoids Option 2's cross-module channel for a benefit already delivered. If
  a future need arises to *also* shrink the transcript copy while the writer
  still gets the full report, revisit Option 2; today it is not worth the surface.
- The ~8,000-char ceiling is belt-and-suspenders: the research prompt already
  targets a short report, so the ceiling never bites a normal report, but it
  bounds a pathological runaway so a single research call cannot blow up the
  writer's context. (Fully uncapped is simpler and defensible too; the ceiling
  is the safer default.)

### Why the 1,500 cap exists (rationale, confirmed from history)

Commit `5647211` ("Feed the writer the full turn transcript") introduced
`renderTranscript` with per-result truncation so durable facts learned through
tools (calendar events, email bodies, research) reach the writer **without** a
full calendar listing or long email body swelling the writer's input. The cap
is a size guard for *context* tool results. Research findings are not context to
sample from; they are the payload to persist. The cap should not apply to them.

### Context-budget check (does exempting research blow up the writer?)

No. The writer runs on the same 16k-`max_tokens`, 300s model as every agent and
already reads **full topic bodies** via `get_topic` during its run, so a few
thousand extra characters of report in the prompt is small next to what the
writer already pulls. Reports are bounded by the research prompt target and by
the research agent's generation (the 17:51Z report was 3,032 chars ≈ ~800
tokens). A turn rarely carries more than 1–2 research calls; the ~8,000-char
research ceiling bounds even a multi-call worst case to a modest fraction of the
writer's budget.

## Interaction with caching (commit `c9b443a`) — confirmed, not assumed

No disturbance to the sliding-breakpoint work. Evidence:

- The writer is invoked with a single per-turn user `prompt`
  (`writer.ts`: `runAgent({ ..., prompt: "# Turn transcript\n\n" + transcript ... })`),
  not a reusable message array. That prompt is agent-specific and changes every
  turn (the transcript differs every turn), so it can **never** be part of a
  shared cross-turn/cross-user cached *prefix* regardless of its size.
- `c9b443a` made `runAgent`'s loop own a **sliding message-region breakpoint**
  that advances to the growing tail *within a single run*, so the writer's first
  step writes its message region to cache and later steps read it back. Enlarging
  the research portion only makes that first-step write a bit bigger, read back
  on later steps — exactly the pattern `c9b443a` implements. The cached prefix
  (tools + system block) is untouched.
- The report sits in the writer's message *tail*, which is inherently
  agent-specific and outside any shared cached prefix. So growing it does not
  move the shared prefix breakpoints.

## Recommendation on the research prompt's "~1,200 characters" instruction

**Relax it modestly and re-anchor its rationale; do not keep the truncation
justification.** Today the prompt (prompts.ts ~178) says "aim for roughly 1,200
characters or less … an overlong report is truncated before it reaches that
agent," and the code comment above it (prompts.ts:143-148) names
`MAX_TOOL_RESULT_CHARS` as the reason. Once Option 1 removes the clip for
research, that reason is false and the instruction is a stale workaround.

Recommended change:

- **Raise the soft target from ~1,200 to ~2,500 characters** and drop every
  mention of downstream truncation. 2,500 chars ≈ ~600 tokens, still compact,
  still well under the ~1,115-token generation the speedup verification
  measured as good — so this does **not** threaten the 48-second research loop
  or that generation size. (Note: the protected 1,115-token / ~3,000-char
  result already *exceeded* the old 1,200-char instruction; the model overran
  because 1,200 was unrealistically tight. Raising the stated target aligns the
  instruction with the already-protected behavior.)
- **Add an enumeration exception:** when the answer is a list where each item
  carries its own distinct source (the cinema case), the report may run longer
  so no item is dropped for length. A fixed character budget fights
  enumerations; that is what produced the 20-item overrun.
- **Keep brevity as the default for prose findings** to protect latency.

The real latency guard should be a hard `max_tokens` on the research call, not
the prompt. That ceiling was proposed in `research-agent-speedup.md` (step 1,
`maxTokens: 2000`) but **did not ship** — `research.ts` calls `runAgent` with no
`maxTokens`, so today only the prompt bounds report length. Wiring that ceiling
is out of scope for this handoff fix but is the durable protection for the
48s loop; note it and consider doing it in the same change if cheap. If it is
added, set it comfortably above the ~2,500-char target (e.g. ~1,200 tokens) so a
normal report is never chopped mid-list.

## Also fix in the same change (stale wording that this bug exposed)

- **Writer prompt** (`writerSystemPrompt`, prompts.ts ~283, "Preserve research
  topics. Some accessed topics were written by the research agent …"): stale —
  research no longer writes topics; the findings now arrive **in the transcript**
  as the `research` tool result, and the writer persists them. Reword so the
  writer knows to persist the research findings from the transcript verbatim
  with every `Source:` URL, and never treat a turn that carried a research
  finding as trivial.
- **Research prompt comment + body** (prompts.ts:143-148 and ~178): remove the
  `MAX_TOOL_RESULT_CHARS`/"truncated before it reaches that agent" rationale per
  the section above.

## Ordered steps

1. **Exempt research from truncation in `renderTranscript`** (interface.ts):
   when the resolved tool name is `research`, apply a research-specific ceiling
   (~8,000 chars) instead of `MAX_TOOL_RESULT_CHARS`; keep 1,500 for all other
   tools. Name the new constant (e.g. `MAX_RESEARCH_RESULT_CHARS`) next to
   `MAX_TOOL_RESULT_CHARS` with a comment pointing at this plan.
2. **Unit tests** (interface.test.ts): see Tests below. Keep the existing
   non-research truncation tests (lines ~259, ~938) green.
3. **Research prompt** (prompts.ts): raise the target to ~2,500 chars, drop the
   truncation rationale, add the enumeration exception; update the comment block.
4. **Writer prompt** (prompts.ts): reword the "Preserve research topics"
   paragraph to persist findings from the transcript verbatim with source URLs.
5. **Docs:** reconcile `docs/research.md` and `docs/topics.md` with the shipped
   flow (research reports through the transcript, writer persists; research
   writes no topics) — these still describe the pre-`131a7f0` behavior in
   places. Verify before editing.
6. **Changelog:** add a user-facing entry to `apps/agent-api/CHANGELOG.md`
   (research answers now keep their full sourced list when saved).
7. **Optional, if cheap:** wire the hard `max_tokens` on the research call
   (`research-agent-speedup.md` step 1) as the durable latency guard.

## Tests (the truncation logic is pure and unit-testable)

`renderTranscript` is a pure function over `(userMessage, messages)`. Add to
interface.test.ts:

- **Research result over the general cap is not clipped:** build messages with a
  `research` tool_use + a tool_result whose text exceeds 1,500 chars and ends
  with a `Source: https://…` URL. Assert the transcript contains the full text
  including the trailing URL and does **not** contain `…[truncated]`.
- **Non-research result over the cap is still clipped:** same length under a
  different tool name (e.g. `gmail_search`) still yields `…[truncated]` and is
  cut at 1,500. (The existing tests at ~259/~938 already cover this; keep them.)
- **Research ceiling still bounds a runaway:** a `research` result longer than
  the research ceiling (~8,000) is truncated at the higher bound (asserts the
  ceiling, not unlimited growth).
- **Boundary:** a research result just under the research ceiling is intact.

Run `pnpm --filter @zero/agent-api run test|lint|typecheck` (whole-repo
`gob run bin/ci` needs `workerd`, unavailable on this box — see AGENTS.md).

## Production verification (a real research turn is required)

The e2e harness never fires research (mock Anthropic issues no tool calls), so
this is production-only and needs a **real user message**.

1. Deploy (push to `main`; `zero-api` auto-builds). Space it out from other
   pushes to limit mid-turn reset blast radius.
2. Tail logs: `gob add pnpm --dir apps/agent-api exec wrangler tail`.
3. Ask the bot a research question whose answer is a **long enumeration with a
   distinct source per item** (the failing shape), e.g. "list the cinemas in
   <neighborhood> with their websites." This forces `report_len > 1500` so the
   exemption path is exercised.
4. Confirm the report overran the old cap: `research_completed.report_len` is
   > 1500.
5. Inspect the **writer's gateway request body** for that turn: the
   `Tool result research:` section ends with the report's real final content
   (its summary line), **not** `…[truncated]`.
6. Read the **stored topic** the writer produced (ask the bot to show it, or
   view it in the app): every enumerated item from the report is present (item
   count matches the report's), each with its `Source:` URL, and the writer added
   **no** "result was truncated" note.
7. `curl -sS -o /dev/null -w "%{http_code}"` each stored source URL and confirm
   it resolves (2xx/3xx).

## Acceptance criteria (objectively checkable)

1. `renderTranscript` leaves a `research` tool_result over 1,500 chars intact
   (no `…[truncated]`, trailing `Source:` URL present) while still truncating a
   non-research result over 1,500 chars — proven by unit tests.
2. A `research` result over the research ceiling (~8,000) is truncated at that
   ceiling — unit test.
3. The research prompt no longer cites downstream truncation, targets ~2,500
   chars, and permits longer enumerations; the writer prompt persists research
   findings from the transcript verbatim with source URLs.
4. `pnpm --filter @zero/agent-api run test|lint|typecheck` pass.
5. `apps/agent-api/CHANGELOG.md` and any stale `docs/research.md` /
   `docs/topics.md` wording updated in the same change.
6. **Production:** on a real research turn with `report_len > 1500`, the writer's
   gateway request body has no `…[truncated]` in the research tool-result
   section, the stored topic's item count equals the report's item count, and
   every stored source URL resolves (2xx/3xx).

## Skills to use

- `tdd` — write the `renderTranscript` exemption tests first, then make them pass.
- `changelog` — before editing `apps/agent-api/CHANGELOG.md`.
- `git-commit` — when committing.
- `reproducible-locally` — for framing the production verification (no e2e path
  for research).
