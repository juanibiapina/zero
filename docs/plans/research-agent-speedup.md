# Research agent speedup — return findings instead of authoring topic bodies

Status: plan only (no code changes). Companion to
`docs/plans/agent-latency-investigation.md`, which measured the problem live on
2026-07-27. Read that first for the evidence; this plan is the fix.

## Goal

Take the research agent from ~12 minutes to **1–2 minutes** by removing the work
that dominates its wall clock: authoring full topic bodies (5–8k output tokens
per write, ~48 tok/s = 2–3 minutes each) **inside** the research loop. The
research agent should **gather and report**, returning a short sourced findings
summary. The writer agent — which already runs every turn — persists those
findings into topics.

Hard requirement (non-negotiable): **the returned findings must carry links to
their sources**, attached per claim, so provenance survives into the stored
topic. Losing source URLs is a failure of this change even if it is fast.

Measured target: the three in-loop body writes on the incident turn were 7,853 /
7,440 / 5,803 output tokens = **437s (7.3 min)** of a ~12-minute turn. Deleting
them, plus a hard `max_tokens` ceiling on the research call, is the single
largest lever.

## Current flow (end to end, with file:line)

**1. Interface agent calls the research tool.**
`apps/agent-api/src/agents/interface.ts:288-295` registers `buildResearchTool`
with `{ model: researchModel ?? model, store, search, fetcher, accessed }`. The
interface's own `accessed` set is passed in. The interface prompt
(`prompts.ts` `interfaceSystemPrompt`, "Research on your own initiative"…) tells
it to call `research` proactively, passing an existing topic name as `topic`
when one is known.

**2. The research tool spawns the research agent.**
`apps/agent-api/src/tools/research.ts:66-84`:
- Tool input is `{ prompt, topic? }` (`research.ts:59-62`).
- It builds a **fresh** `written = new Set<string>()` and hands the research
  agent `buildTopicTools({ store, accessed: written })` +
  `buildWebSearchTool` + `buildReadPageTool` (`research.ts:69-73`). So research
  gets **list_topics, get_topic, create_topic, update_topic** (the four in
  `buildTopicTools`, `tools/topics.ts:31-137`) plus `web_search` and
  `read_page`. **No `reply`, no `delete_topic`.**
- It runs `runAgent({ model, system: researchSystemPrompt(), prompt: agentPrompt, tools })`
  (`research.ts:80-85`) with the default `maxSteps = AGENT_MAX_STEPS = 200`
  (`run.ts:38`) and the default `max_tokens = 16000` hardcoded in
  `model.ts:52` for every call.

**3. The research system prompt tells it to author bodies in-loop.**
`prompts.ts` `researchSystemPrompt()`: "you investigate it with web search and
**write your findings into a topic**"; "Your findings live in the **topic you
write**, not in your final message"; "create_topic, then fill it with
update_topic"; "Every claim … MUST be backed by a reference: keep the source URL
… in the body." This is what produces the 5–8k-token `update_topic` bodies that
eat the wall clock.

**4. What the tool returns to the interface today.**
`research.ts:88-113`:
- Safety net: if `written.size === 0`, it deterministically creates a fallback
  topic named from `prompt` and writes the agent's final `text` as the body
  (`research.ts:89-94`).
- It merges every `written` name into the interface's `accessed` set
  (`research.ts:98`), so the writer will consolidate them.
- It logs `research_completed` and returns the string
  `"Saved to topic '<name>'.\n\n<final text>"` (`research.ts:107-112`). That
  string is the `research` **tool result** the interface model reads to compose
  the user's answer.

**5. What the writer receives afterwards.**
`orchestrator.ts:106-125`: after the interface agent returns, `runWriterAgent`
is called **every turn** with `{ model, store, accessed, transcript }`.
- `accessed` includes the research-written topic names (merged in step 4).
- `transcript` is `renderTranscript(userMessage, messages)`
  (`interface.ts:170-199`), a serialization of the interface run. **Every tool
  result in the transcript is truncated to `MAX_TOOL_RESULT_CHARS = 1500`**
  (`interface.ts:148-166`). So the research tool result is truncated to 1500
  chars in the transcript.
- The writer (`writer.ts:31-49`) reads each accessed topic's **full body** via
  `get_topic` and merges/preserves. `writerSystemPrompt()` ("Preserve research
  topics … keep those findings and their reference URLs verbatim") relies on the
  research agent having already written the full sourced body into the topic.

**Why this matters for the redesign.** Today the source URLs reach durable
storage because the research agent writes them into the topic body directly, and
the writer reads that full body. The lossy 1500-char transcript truncation does
**not** hurt provenance today because the writer does not depend on the
transcript for the URLs — it reads the topic body. If we stop research writing
the body, the findings (and their URLs) must reach the writer through some other
channel that is **not** the 1500-char-truncated transcript, or they are lost.
This is the crux of the design.

## What changes

Two structural changes plus enforcement:

1. **Strip topic-write tools from the research agent.** Give it read-only topic
   context (`list_topics`, `get_topic`) + `web_search` + `read_page`. Removing
   `create_topic`/`update_topic` structurally makes an in-loop body write
   impossible (not merely discouraged by prompt).
2. **Research returns a bounded sourced findings report** as its tool result,
   and the same report is captured verbatim into a dedicated findings channel
   that flows interface → orchestrator → writer, bypassing the truncated
   transcript. The writer persists it into a topic, preserving every source URL.
3. **Enforce the budget with a hard `max_tokens` on the research call**, not
   prompt text alone. Also lower research `maxSteps`.

### The return / findings shape

Concrete type (new, e.g. in `tools/research.ts` or a small shared module):

```ts
export interface ResearchFinding {
  // What was researched (the tool's `prompt`), so the writer can route it.
  subject: string;
  // The existing topic the interface named as relevant, if any. The writer
  // merges into this topic instead of creating a duplicate; undefined means
  // the writer decides (find-or-create by subject).
  topic?: string;
  // Bounded markdown: sourced claims, each with its source URL attached
  // inline. This is the exact text returned to the interface as the tool
  // result AND captured for the writer — one string, no divergence.
  report: string;
}
```

`report` format — sources attached **per claim**, never dumped at the end:

```
## <subject> — findings

- <claim 1>. Source: <url>
- <claim 2>. Sources: <url>, <url>   (when corroborated)
- Uncertain/contested: <claim>. Source: <url>

Summary: <1–2 sentences>. Open questions: <if any>.
```

**Length budget.** `report` is capped at **~600 output tokens (~2,400
characters)**. Rationale: at ~48 tok/s a 600-token final generation is ~13s
(versus 117–165s for the 5.8–7.9k-token body writes). 600 tokens comfortably
holds ~8–12 sourced bullet claims plus a summary — enough for an interactive
assistant answer, and the writer expands/reorganizes into the durable body
anyway. This budget is deliberately far below the transcript's 1500-char cap
consideration because we are **not** routing it through the transcript (see
below); the budget is about generation time, not transcript survival.

**Budget enforcement (prompt alone is too weak — the incident proves the model
overruns).** Add an optional per-call `maxTokens` to the model seam and set it
low for the research agent:
- `protocol.ts` `AgentModelRequest`: add optional `maxTokens?: number`.
- `model.ts`: `max_tokens: request.maxTokens ?? MAX_TOKENS` (default 16000
  unchanged for interface/writer).
- `run.ts` `RunAgentInput`: add optional `maxTokens`, forward it into every
  `model.generate` call in the loop.
- `research.ts`: pass `maxTokens: 2000` (headroom over the 600-token report so
  a slightly longer report is not chopped, while still bounding any single
  research generation to ~40s worst case). Because the cap applies to **every**
  step, the short tool-call steps (a search query or two) are unaffected; only a
  runaway generation is bounded. A generation that hits the cap returns
  `finishReason: "length"` with the text produced so far — the leading sourced
  bullets survive, which is why the prompt orders claims-with-sources first.
- Also lower research `maxSteps` from the default 200 to **~15** (a
  gather-and-report loop finishes in a handful of steps; 15 gives headroom while
  bounding a pathological loop). Pass `maxSteps: 15` from `research.ts`.

### Making the source links survive (provenance trace)

The findings must reach the writer **without** passing through the 1500-char
transcript truncation. Add a dedicated findings channel:

1. **Research produces** `report` with inline `Source: <url>` per claim
   (prompt-enforced; the search adapter returns real URLs in `SearchResult.url`,
   and `read_page` is called on the ones that matter).
2. **Research tool captures** each `ResearchFinding` into a `findings: ResearchFinding[]`
   collector passed in via `ResearchToolDeps` (replacing today's `accessed`
   merge). It also returns `report` as the tool-result string so the interface
   model can answer the user.
3. **Interface threads it through.** `buildResearchTool` gets `{ …, findings }`
   instead of `{ …, accessed }`. `runInterfaceAgent` owns the array and returns
   it in `InterfaceAgentResult` as `researchFindings`.
4. **Orchestrator forwards it.** `runTurn` passes `researchFindings` to
   `runWriterAgent` as an explicit input, **separate from `transcript`**.
5. **Writer persists it.** `runWriterAgent` renders the findings into its prompt
   in full (not truncated) and the writer prompt orders it to persist each
   finding into the named `topic` (or find-or-create by `subject`), **preserving
   every `Source:` URL verbatim** and never treating a research finding as
   trivial.
6. **Stored topic** ends up with the sourced body in SQLite via
   `create_topic`/`update_topic`.

**Every place a URL could be dropped, and the guarantee it is not:**

| Drop point | Guarantee |
|---|---|
| Transcript truncation (1500 chars) | Findings travel a **separate `researchFindings` channel**, not the transcript. |
| `max_tokens` cap chopping the report mid-list | Budget (600) sits well under the cap (2000); prompt orders sourced claims first, so anything emitted is a complete sourced bullet. |
| Model omitting the URL from a claim | Prompt: "no claim without an inline source URL"; sources attached per claim, not appended once at the end. |
| Writer paraphrasing away the URL | Writer prompt: "preserve every Source URL verbatim; refresh summary, do not rewrite the sourced claims." (Strengthen the existing research-preservation clause.) |
| Writer skipping the finding as "trivial" | Writer prompt: a turn carrying a research finding is **never** trivial; always persist it. |

The acceptance criteria (below) require reading a **real stored topic** after a
production research turn and confirming the URLs resolve.

### Read-only topic tools for research

`buildTopicTools` bundles all four topic tools. Add a read-only variant (e.g.
`buildTopicReadTools` in `tools/topics.ts` returning only `list_topics` +
`get_topic`) and give research that plus `web_search` + `read_page`. Research
no longer needs an `accessed` set (it writes nothing); reads for context need
not be recorded, since the writer is driven by the findings channel, not by what
research read.

## Prompt replacements (exact text)

### `researchSystemPrompt()` — full replacement

```
You are a research agent. You are given a subject to research. You investigate
it with web search and RETURN a short, sourced findings report. You do not
write or edit topics — another agent persists your findings. Your report is
your only output; make it complete and self-contained.

You have read-only topic access (list_topics, get_topic) for context,
web_search, and read_page. web_search returns only short snippets; when a
result is load-bearing, call read_page on its url to read the full page before
you rely on it. Be selective — read the pages that matter, not every result —
to control latency.

Before searching:
- Skim relevant topics for context with list_topics and get_topic (read the
  named prior topic if the prompt gives one). This is context only; do not try
  to write topics — you have no write tools.

Investigate:
- Start broad, then narrow. Run a few searches, refining terms from what each
  result teaches you.
- Open load-bearing sources with read_page; don't rely on a snippet alone for
  anything a claim rests on.
- Corroborate important claims across independent sources; prefer primary or
  authoritative ones. Note when sources disagree.
- Stop as soon as further searches stop changing the answer, or the evidence is
  clearly thin. Do not keep searching for its own sake.

Report your findings — this is the whole job:
- Write a SHORT markdown report: at most ~10 bullet claims plus a one- or
  two-sentence summary. Keep it under roughly 400 words. Brevity is required;
  the report is read by the user and expanded into durable notes by another
  agent.
- Attach a source to EVERY claim, inline, right after it: "…claim. Source:
  <url>" (or "Sources: <url>, <url>" when corroborated). No claim may appear
  without a source URL. Put the sourced claims first; put any summary and open
  questions last, so nothing load-bearing is lost if the report is trimmed.
- Distinguish established from uncertain, contested, or time-sensitive, and
  surface open questions rather than papering over gaps.
- If the searches did not answer the question, say so plainly with what you did
  find and its sources. Never invent facts or sources.
- Do not restate the sources in a separate list at the end; each source stays
  with its claim.
```

### `writerSystemPrompt()` — replace the "Preserve research topics" paragraph

Current:

```
Preserve research topics. Some accessed topics were written by the research
agent and hold findings with source URLs. Keep those findings and their
reference URLs verbatim — refresh the summary rather than rewriting the body. If
two research topics cover the same subject, fold them together, preserving every
source URL.
```

Replacement:

```
Persist research findings. This turn may include a "Research findings" section:
sourced findings the research agent gathered but did NOT store (it has no write
tools). Each finding names a subject, an optional target topic, and a report of
claims each carrying an inline "Source: <url>". You MUST persist every finding:
merge it into the named target topic (or, if none, the best existing topic for
the subject, else create one), keeping every claim's source URL verbatim in the
body. Never drop a source URL, and never treat a turn that carried a research
finding as trivial. If a finding duplicates an existing topic, fold it in,
preserving every source URL.
```

And extend `runWriterAgent`'s user prompt (`writer.ts:41-46`) to render the
findings, e.g. append a `# Research findings` section listing each finding's
`subject`, `topic`, and full `report` (untruncated) when `researchFindings` is
non-empty.

### `interfaceSystemPrompt()` — soften the "writes topics" wording

The "Research on your own initiative" paragraph says research "reads and writes
topics." Reword to: research "looks things up and reports back; reference its
findings in a natural reply" and keep passing an existing topic name as `topic`
so research reads it for context. Minor; keeps the interface from claiming the
topic is already saved.

## Ordered steps

1. **Model seam: per-call `max_tokens`.** Add `maxTokens?` to
   `AgentModelRequest` (`protocol.ts`), use `request.maxTokens ?? MAX_TOKENS` in
   `model.ts`, add `maxTokens?` to `RunAgentInput` and forward it in the
   `generate` call in `run.ts`. Unit-test with `capturingModel` that a provided
   `maxTokens` reaches the request (`model.test.ts` / a `run` test).
2. **Read-only topic tools.** Add `buildTopicReadTools` (list_topics + get_topic)
   in `tools/topics.ts`.
3. **Findings channel type + collector.** Add `ResearchFinding`; change
   `ResearchToolDeps` to take `findings: ResearchFinding[]` instead of
   `accessed`.
4. **Rewrite `buildResearchTool`** (`tools/research.ts`): read-only topic tools +
   web_search + read_page; `runAgent({ …, maxTokens: 2000, maxSteps: 15 })`;
   push a `ResearchFinding { subject: prompt, topic, report: text }` to
   `findings`; return `report` (the text) as the tool result; drop the
   fallback-topic write and the `accessed` merge; keep `research_started` /
   `research_completed` logs (drop the `topics` field, add `report_len` /
   `finish_reason`).
5. **Rewrite `researchSystemPrompt()`** with the text above.
6. **Interface wiring** (`interface.ts`): own a `researchFindings: ResearchFinding[]`
   array, pass it to `buildResearchTool`, return it in `InterfaceAgentResult`.
   Soften the interface prompt research paragraph.
7. **Orchestrator wiring** (`orchestrator.ts`): pass `researchFindings` from the
   interface result into `runWriterAgent`.
8. **Writer** (`writer.ts`): accept `researchFindings`, render them full into the
   prompt, update `writerSystemPrompt()` preservation clause.
9. **Docs:** update `docs/research.md` (research returns findings; the writer
   persists them; the tool no longer writes topics; no fallback topic),
   `docs/topics.md` (the "third agent writes topics" paragraph — research no
   longer writes; the writer persists research findings from a dedicated
   channel).
10. **Changelog:** add a user-facing entry to `apps/agent-api/CHANGELOG.md`
    (research answers now arrive in ~1–2 minutes instead of many minutes).
11. **Tests:** rewrite `research.test.ts`; add/extend a writer test proving the
    findings→topic path preserves a URL; add the model `maxTokens` test.

## Risks and dependencies

- **Does anything else depend on research writing topics directly?** Searched:
  the only writers of topics via research are the in-loop `update_topic`/
  `create_topic` tool calls and the fallback in `research.ts:89-94`. The tool's
  result string and the `accessed` merge are the only downstream couplings, both
  changed here. `docs/research.md` and `docs/topics.md` describe the old
  behavior (updated in step 9). e2e never fires research (mock Anthropic issues
  no tool calls — `docs/research.md` "e2e" section), so nothing there breaks.
  **Conclusion:** dropping the write tools loses no data **provided** the writer
  persists the findings channel — which is exactly what steps 6–8 wire. Without
  the findings channel, a research result would vanish (no topic written, and
  the transcript is truncated), so the writer wiring is load-bearing and must
  land in the same change.
- **`max_tokens` cutting a tool-use step.** The 2000-token cap applies to every
  research step. A step emitting only search queries is far under 2000 tokens,
  so a mid-`tool_use` truncation is unlikely; the real risk is the final report,
  which is text and degrades gracefully (leading sourced bullets survive).
- **Writer prompt adherence for URL preservation.** Prompt-enforced, same class
  of guarantee as today. If it degrades, the stronger fix is a mechanical
  copy-through (writer appends the finding `report` verbatim into a body region
  it never rewrites). Out of scope unless production shows drops.
- **Interface over-promising.** With no in-loop write, the topic exists only
  after the writer runs (same turn, moments later). The interface prompt reword
  avoids "saved to topic X" phrasing.
- **Deploy resets (secondary, from the investigation).** Shrinking the loop from
  ~12 min to ~1–2 min directly shrinks the window for a mid-turn DO isolate
  reset and its retry cost. Not fixed here, but improved as a side effect.

## Testable here vs. production-only

Runnable on this box (vitest, no network, no `workerd`):
- `research.test.ts` rewrite: after a scripted research run, assert
  `store.listTopics()` is **empty** (research writes nothing), the tool result
  string contains the source URL, and the `findings` collector captured a
  `ResearchFinding` whose `report` contains the URL. Assert with `capturingModel`
  that the research call's request carries `maxTokens` = 2000 and the lowered
  `maxSteps`.
- Writer test: given a `researchFindings` input and a scripted writer that emits
  `create_topic` + `update_topic` echoing the finding, assert the stored topic
  body contains the source URL — proving the interface→orchestrator→writer→store
  path preserves URLs mechanically.
- Model seam test: `generate` sends `max_tokens` from `request.maxTokens` when
  provided, else 16000.
- Full `gob run bin/ci` cannot run here (needs `workerd`); fall back to
  `pnpm --filter @zero/agent-api run test|lint|typecheck` (per AGENTS.md).

Production-only (cannot be proven here):
- A **real** model actually returning a sourced report under budget, and a
  **real** writer preserving the URLs into the body. Unit tests use scripted
  models, so they prove wiring, not model behavior.
- End-to-end latency. The e2e harness never triggers research.

## Production verification

1. Deploy (push to `main`; `zero-api` auto-builds). Space it out from other
   pushes to limit reset blast radius.
2. Tail logs: `gob add pnpm --dir apps/agent-api exec wrangler tail`. Watch for
   `research_started` → `research_completed` (`duration_ms`, `finish_reason`,
   `report_len`).
3. Ask the bot a real research question (a fresh subject, so a topic is created).
   Record wall clock from sending the message to the substantive reply.
4. Confirm timing: the substantive answer arrives in **1–2 minutes**;
   `research_completed.duration_ms` is well under ~120s; in the **AI Gateway**
   `zero` logs, no single `agent: "research"` call generates more than ~600–2000
   output tokens or runs longer than ~40s (contrast the incident's 117–165s
   writes).
5. Confirm provenance: read the **stored topic** the writer produced — ask the
   bot to show that topic's body (it calls `get_topic`), or view it in the
   app — and confirm it contains source URLs. `curl -sS -o /dev/null -w "%{http_code}"`
   each URL and confirm they resolve (2xx/3xx).

## Acceptance criteria (objectively checkable)

1. The research agent has **no** `create_topic`/`update_topic` tool; a scripted
   research run leaves `store.listTopics()` empty.
2. The `research` tool result and the captured `ResearchFinding.report` both
   contain the source URL(s) from the search results (unit test).
3. The research model call carries `max_tokens = 2000` and `maxSteps = 15`
   (unit test via `capturingModel`); `generate` honors `request.maxTokens`.
4. A writer unit test proves a `researchFindings` input lands a source URL in the
   stored topic body.
5. `pnpm --filter @zero/agent-api run test|lint|typecheck` pass.
6. Docs (`docs/research.md`, `docs/topics.md`) and
   `apps/agent-api/CHANGELOG.md` updated in the same change.
7. **Production:** a real research question is answered in **1–2 minutes**
   (measured wall clock), `research_completed.duration_ms` < ~120s, and no
   single `agent:"research"` gateway call exceeds ~40s / ~2000 output tokens.
8. **Production:** the topic the writer produced for that turn contains source
   URLs, and each URL resolves (2xx/3xx via `curl`).

## Skills to use

- `tdd` — for the model-seam, research-tool, and writer wiring changes
  (rewrite `research.test.ts` first, then make it pass).
- `deep-modules` — the findings channel is the seam; keep the transcript and the
  findings channel distinct (the transcript stays lossy/truncated, findings do
  not).
- `changelog` — before editing `apps/agent-api/CHANGELOG.md`.
- `git-commit` — when committing.

---

## Note: zero-docs build banner (observed, not fixed here)

The `zero-docs` Workers Builds connector shows a "last build failed" banner. I
checked whether the live site is affected:

- `https://docs.zeroapps.dev/` → **200**, `<title>Zero Docs</title>`,
  `cf-cache-status: HIT`.
- `https://docs.zeroapps.dev/vault/overview/` → **200** (real content page).
- `https://docs.zeroapps.dev/llms.txt` → served, current content.

**Conclusion:** the live docs site is serving current content; the last failed
build did **not** take it down (a prior successful build is still deployed).
Flagged per instructions; **not** fixed as part of this task. Worth a separate
look at the Workers Builds logs for the failing `apps/docs` build so the next
docs change actually ships.
