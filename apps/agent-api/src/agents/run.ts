// The one agent machine: model + system + prompt + tools + step cap → final
// assistant text. The interface agent and the research agent are the same
// runner instantiated with different system prompts and toolsets. It has no
// opinion about the output (no fallback); callers decide what the text means.
//
// The loop is Zero's own: send a request, append the assistant response
// verbatim, run every tool_use block, append one user turn of tool_result
// blocks, repeat until the model stops calling tools. Round-tripping the
// response content untouched keeps tool ids, inputs, and any block type we
// don't model intact.

import {
  toToolDefinitions,
  type AgentMessage,
  type AgentModel,
  type AgentToolSet,
  type ContentBlock,
  type StopReason,
  type TextBlock,
  type TokenUsage,
  type ToolResultBlock,
  type ToolResultContent,
  type ToolUseBlock,
} from "./protocol";
import { cachedSystem, markLastTool, slideMessageBreakpoint } from "./cache";

// Shared step cap for every agent (interface and research). The cap is a
// runaway-loop guard, not an expected stopping point: the model normally
// finishes in a handful of steps. 200 gives generous headroom while still
// bounding pathological loops.
//
// Tradeoff of a high cap: (a) the Cloudflare subrequest ceiling — 1000
// subrequests per invocation; each step is >=1 LLM call, research adds search
// calls, and interface x research nest multiplicatively — and (b) longer
// wall-clock time, which widens the window for mid-run DO eviction. 200 is a
// safety net; if runaway loops show up in logs (finish_reason != "stop" with a
// high step count), lower it.
export const AGENT_MAX_STEPS = 200;

// Durable bookkeeping for calls that cannot be replayed. Implemented by the
// store; omitted by agents with no external writes (research, writer).
export interface ExternalCallGuard {
  begin(
    toolUseId: string,
    tool: string,
  ):
    | { status: "claimed" }
    | { status: "in_flight" }
    | { status: "completed"; result: string };
  complete(toolUseId: string, result: string): void;
}

// What the model is told about a call an earlier attempt started and never
// finished recording. It is an error result, so the model must react to it, and
// it says the one thing that is true: nobody knows whether it went out.
export const UNCERTAIN_EXTERNAL_CALL =
  "This action was already started by an earlier attempt at this turn and its " +
  "outcome was never recorded, so it may or may not have gone through. Do not " +
  "retry it. Tell the user to check Gmail or Calendar to confirm before trying " +
  "again.";

export interface RunAgentInput {
  model: AgentModel;
  system: string;
  // Either a single user `prompt` string (wrapped into one user message) or a
  // full `messages` array. The interface agent passes structured `messages`
  // (native user/assistant turns); research, writer, and onboarding pass a
  // `prompt`. When both are present, `messages` wins.
  prompt?: string;
  messages?: AgentMessage[];
  tools?: AgentToolSet;
  maxSteps?: number;
  // Called once per model response, with the response content verbatim, before
  // any of its tools run and before its text is delivered. The interface agent
  // persists the response here, so the durable log gains the assistant message
  // ahead of every side effect it asks for. The returned value is the stored row
  // id, threaded into `onText` so a caller can claim each text block for
  // delivery.
  onAssistant?: (
    content: ContentBlock[],
    stopReason: StopReason | null,
    responseId: string,
  ) => Promise<number | null>;
  // Called once per text block the model produces, in order, as each step
  // completes and before that step's tools run. The interface agent uses it to
  // deliver messages as the model writes them: in a normal agent the assistant's
  // text blocks ARE the messages. `ref` names the persisted row and the block's
  // index inside it, which is what a delivery claim is keyed by. It is awaited,
  // so a persist-before-send hook completes before the loop continues, and a
  // throw propagates out of the run (it is not a tool error the model can
  // retry).
  onText?: (
    text: string,
    ref: { messageId: number | null; blockIndex: number },
  ) => Promise<void>;
  // Called with one step's ordered tool results, before the next model call, so
  // the durable log carries what the tools returned rather than re-fetching them
  // next turn.
  onToolResults?: (results: ToolResultBlock[]) => Promise<void>;
  // Called at the point the loop would otherwise stop (the model asked for no
  // tools). Returning messages continues the same loop with them appended: this
  // is how Telegram messages that arrived mid-run are injected without ever
  // interrupting a tool sequence. Returning nothing ends the run.
  onIdle?: () => Promise<AgentMessage[]>;
  // Durable at-most-once bookkeeping for tools marked `externalWrite`. Without
  // it such a tool is simply run, which is what tests and the read-only agents
  // want.
  externalCalls?: ExternalCallGuard;
  // The id of the last response this conversation received, from an earlier run.
  // With an append-only log turn N+1's prefix extends turn N's, so chaining to
  // it is what makes a cross-turn cache break visible. Null/undefined starts a
  // fresh chain.
  previousResponseId?: string | null;
  // Prompt caching on by default: the system text gets a 1h cache breakpoint
  // and so does the last tool. Set false to opt out (tests that assert the
  // plain shape).
  cache?: boolean;
}

// Token counts for one run (aggregate) or one step.
export type RunAgentUsage = TokenUsage;

export interface RunAgentResult {
  text: string;
  // "stop" means the model produced a final answer; anything else (notably
  // "tool-calls") means the loop was cut off before a final answer — callers
  // use this to detect cap exhaustion and deliver a fallback.
  finishReason: string;
  steps: number;
  // The assistant + tool-result messages generated across every step this run.
  // Callers serialize these into a turn transcript so a downstream agent sees
  // what tools returned, not only the final text.
  messages: AgentMessage[];
  // Whole-run token totals, summed across every tool-loop step.
  usage: RunAgentUsage;
  // Per-step token counts. The tier-1 write-then-read pattern (step 1 writes the
  // prefix, later steps read it) is invisible in the aggregate, so callers read
  // this to see it. Empty for a zero-step run.
  stepUsages: RunAgentUsage[];
}

const ZERO_USAGE: RunAgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const sumUsage = (usages: RunAgentUsage[]): RunAgentUsage =>
  usages.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + u.cacheWriteTokens,
    }),
    ZERO_USAGE,
  );

// Compact log fields for a completion line: token totals plus a single
// cache-hit signal. `cache_hit_ratio` = reads / (reads + writes + uncached
// input); on a multi-step turn the read term counts the prefix once per step,
// so read it as a turn-level signal and use the per-step breakdown for the
// within-run write-then-read check.
export const usageLogFields = (usage: RunAgentUsage) => {
  const denom =
    usage.cacheReadTokens + usage.cacheWriteTokens + usage.inputTokens;
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    cache_hit_ratio:
      denom > 0 ? Number((usage.cacheReadTokens / denom).toFixed(3)) : 0,
  };
};

// Anthropic stop reason -> the runner's finish reason. Only `end_turn` and
// `stop_sequence` are a real final answer; everything else (including a null
// stop reason and cap exhaustion) must be distinguishable so the interface
// agent falls back instead of delivering empty text.
export const FINISH_REASON: Record<StopReason, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool-calls",
  max_tokens: "length",
  refusal: "refusal",
  pause_turn: "pause",
  compaction: "compaction",
  model_context_window_exceeded: "context-window-exceeded",
};

const finishReasonFor = (stop: StopReason | null): string =>
  stop === null ? "unknown" : (FINISH_REASON[stop] ?? "unknown");

const isToolUse = (block: ContentBlock): block is ToolUseBlock =>
  block.type === "tool_use";

// The tool calls a persisted assistant tail is still waiting on. Empty for
// anything else, including a normal caller-supplied prompt, so a fresh run is
// unaffected.
const pendingToolCalls = (message: AgentMessage | undefined): ToolUseBlock[] => {
  if (!message || message.role !== "assistant") return [];
  if (typeof message.content === "string") return [];
  return message.content.filter(isToolUse);
};

const isText = (block: ContentBlock): block is TextBlock =>
  block.type === "text";

// Deterministic text for an ordinary tool output. Strings pass through; other
// values become JSON so the model sees the structure the tool returned.
const serializeOutput = (output: unknown): string => {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
};

const errorResult = (
  toolUseId: string,
  message: string,
): ToolResultBlock => ({
  type: "tool_result",
  tool_use_id: toolUseId,
  content: message,
  is_error: true,
});

// Run one tool call. Unknown tool names, inputs that fail schema validation, and
// exceptions thrown by `execute` all come back as error tool results fed to the
// model, never as a rejected run: the interface agent relies on a failed `reply`
// send surfacing after the loop, not as a mid-loop throw.
const runTool = async (
  tools: AgentToolSet,
  call: ToolUseBlock,
  guard?: ExternalCallGuard,
): Promise<ToolResultBlock> => {
  const tool = tools[call.name];
  if (!tool) {
    return errorResult(call.id, `Unknown tool: ${call.name}`);
  }
  const parsed = tool.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    return errorResult(
      call.id,
      `Invalid input for tool ${call.name}: ${parsed.error.message}`,
    );
  }
  // An irreversible call is claimed before it leaves. A replay (the same
  // tool_use id after a reset) therefore lands on the existing row: a finished
  // call hands back its recorded result, an unfinished one is reported as
  // uncertain rather than fired again. At-most-once, explicitly — the same
  // tradeoff as Telegram delivery, since no external API here offers
  // exactly-once.
  const claim =
    tool.externalWrite && guard
      ? guard.begin(call.id, call.name)
      : { status: "claimed" as const };
  if (claim.status === "completed") {
    return { type: "tool_result", tool_use_id: call.id, content: claim.result };
  }
  if (claim.status === "in_flight") {
    return errorResult(call.id, UNCERTAIN_EXTERNAL_CALL);
  }
  try {
    const output = await tool.execute(parsed.data);
    if (tool.toContent) {
      const { content, isError } = tool.toContent(output);
      if (tool.externalWrite && guard)
        guard.complete(call.id, typeof content === "string" ? content : "");
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content,
        ...(isError ? { is_error: true } : {}),
      };
    }
    const content: ToolResultContent = serializeOutput(output);
    if (tool.externalWrite && guard) guard.complete(call.id, content);
    return { type: "tool_result", tool_use_id: call.id, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A throw means the tool itself reported failure, so the outcome is known
    // and the model may try again with the next call id.
    if (tool.externalWrite && guard) guard.complete(call.id, message);
    return errorResult(call.id, message);
  }
};

export const runAgent = async (
  input: RunAgentInput,
): Promise<RunAgentResult> => {
  const cache = input.cache ?? true;
  const tools = input.tools ?? {};
  const callerMessages: AgentMessage[] = input.messages ?? [
    { role: "user", content: input.prompt ?? "" },
  ];

  // Cache order is tools -> system -> messages. Mark the last tool (which covers
  // every schema before it) and the system block; both use a 1h TTL because they
  // are shared across users and stay permanently warm. The messages region gets
  // a loop-owned sliding breakpoint per step (below); any caller anchor
  // breakpoint set on an earlier message is preserved.
  const definitions = toToolDefinitions(tools);
  const wireTools = cache ? markLastTool(definitions, "1h") : definitions;
  const system: TextBlock[] = cache
    ? cachedSystem(input.system, "1h")
    : [{ type: "text", text: input.system }];

  const messages: AgentMessage[] = [...callerMessages];
  const generated: AgentMessage[] = [];
  const stepUsages: RunAgentUsage[] = [];
  const maxSteps = input.maxSteps ?? AGENT_MAX_STEPS;
  // Cache-diagnostic chain: the first request names the conversation's last
  // response (from an earlier turn) when there is one, and every later one names
  // this run's previous response. Each step only appends, and so does each turn,
  // so both comparisons are meaningful (see docs/caching.md).
  let previousMessageId: string | null = input.previousResponseId ?? null;
  let crossRun = previousMessageId !== null;

  // Resume: the caller's log can end on an assistant response whose tool_use
  // blocks never got results, because a reset landed between persisting the
  // response and persisting its results. The wire format has no valid request in
  // that state, so run those tools now and open the loop with their results.
  // Re-running is safe by construction: read tools are pure, topic writes carry
  // the expected knowledge version so an already-applied write conflicts instead
  // of duplicating, and external writes guard themselves (see tools/).
  const resumeCalls = pendingToolCalls(messages[messages.length - 1]);
  if (resumeCalls.length > 0) {
    const results = await Promise.all(
      resumeCalls.map((call) => runTool(tools, call, input.externalCalls)),
    );
    const toolTurn: AgentMessage = { role: "user", content: results };
    messages.push(toolTurn);
    generated.push(toolTurn);
    await input.onToolResults?.(results);
  }

  for (let step = 0; step < maxSteps; step++) {
    // Snapshot: the loop keeps appending to `messages`, and the request must not
    // mutate under the adapter after it is handed over. When caching is on, the
    // snapshot also carries the sliding message-region breakpoint on its tail
    // (5m TTL, the default), advancing to the new last message every step so a
    // cache write stays within the 20-block lookback of the growing tail. The
    // persisted `messages` array is never mutated, so no breakpoints accumulate.
    const requestMessages = cache
      ? slideMessageBreakpoint(messages)
      : [...messages];
    const response = await input.model.generate({
      system,
      messages: requestMessages,
      tools: wireTools,
      previousMessageId,
      crossRun,
      step,
    });
    previousMessageId = response.id;
    crossRun = false;
    stepUsages.push(response.usage);

    // Round-trip the response content verbatim: tool ids, inputs, and block
    // types the protocol does not model must survive into the next request.
    const assistant: AgentMessage = {
      role: "assistant",
      content: response.content,
    };
    messages.push(assistant);
    generated.push(assistant);
    // Persist before anything leaves the isolate: the response is in the log
    // ahead of its tool side effects and ahead of any Telegram send.
    const messageId =
      (await input.onAssistant?.(
        response.content,
        response.stopReason,
        response.id,
      )) ?? null;

    for (const [blockIndex, block] of response.content.entries()) {
      if (!isText(block) || block.text.trim() === "") continue;
      await input.onText?.(block.text, { messageId, blockIndex });
    }

    const calls = response.content.filter(isToolUse);
    if (calls.length > 0) {
      // Parallel execution, results kept in call order (the API requires one
      // tool_result per tool_use, and pairs them by id).
      const results = await Promise.all(
        calls.map((call) => runTool(tools, call, input.externalCalls)),
      );
      const toolTurn: AgentMessage = { role: "user", content: results };
      messages.push(toolTurn);
      generated.push(toolTurn);
      await input.onToolResults?.(results);
      continue;
    }

    // The model asked for no tools, so this is where the run would end. Any
    // message that arrived while it was working gets injected here and answered
    // by the same loop; follow-ups never cut into a tool sequence.
    const injected = (await input.onIdle?.()) ?? [];
    if (injected.length > 0) {
      messages.push(...injected);
      generated.push(...injected);
      continue;
    }

    return {
      text: response.content
        .filter(isText)
        .map((b) => b.text)
        .join("\n"),
      finishReason: finishReasonFor(response.stopReason),
      steps: stepUsages.length,
      messages: generated,
      usage: sumUsage(stepUsages),
      stepUsages,
    };
  }

  // Cap exhausted mid-tool-call: no final answer was produced.
  return {
    text: "",
    finishReason: "tool-calls",
    steps: stepUsages.length,
    messages: generated,
    usage: sumUsage(stepUsages),
    stepUsages,
  };
};
