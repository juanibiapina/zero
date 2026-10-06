import type {
  AssistantMessage,
  Message,
  Models,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  CompactionTask,
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  section,
  ToolTask,
  type AgentChange,
  type ConversationId,
  type Extension,
  type HarnessSettings,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { AgentLabel } from "../agents/model";
import { MAX_RETRIES, REQUEST_TIMEOUT_MS } from "../agents/catalog";
import {
  adminTaskSystemPrompt,
  compactionSystemPrompt,
  interfaceContext,
  interfaceSystemPrompt,
  learnerSystemPrompt,
  onboardingSystemPrompt,
  renderPinnedTopics,
} from "../agents/prompts";
import { STALE_TOPIC_STUB } from "../store/messages";
import type { Topic } from "../store/types";
import type { ModelChoices } from "./models";
import { BACKGROUND } from "./context";
import { toDurableTools, type ToolsetFor } from "./tools";
import { TOOL_SHAPES } from "./toolsets";

export type AgentKind = "interface" | "learner" | "onboarding" | "admin";

export const AGENT_LABEL: Record<AgentKind, AgentLabel> = {
  interface: "interface",
  learner: "learner",
  onboarding: "onboarding",
  admin: "admin_task",
};

export const MAX_TOOL_ROUNDS = 200;

export const STEP_LIMIT_MESSAGE =
  "Tool limit reached for this message. Answer the user now with what you have, without calling more tools.";

export const ZERO_CONTEXT_BUDGET_TOKENS = 45_000;

export interface RequestContext {
  knowledgeVersion: number;
  pinned: Topic[];
  timezone: string;
  country?: string;
}

export interface ZeroHarnessDeps {
  models: Models;
  choices: ModelChoices;
  toolsets: Record<AgentKind, ToolsetFor>;
  requestContext: () => Promise<RequestContext>;
  summarize: (messages: readonly Message[]) => Promise<string>;
  onCompaction?: (conversationId: ConversationId) => void;
  recordUsage?: (input: {
    conversationId: ConversationId;
    agent: AgentLabel;
    message: AssistantMessage;
  }) => void;
  contextWindow: number;
  contextBudgetTokens?: number;
  retry?: HarnessSettings["retry"];
  now?: () => Date;
}

export interface ZeroRegistry {
  registry: Registry;
  settings: HarnessSettings;
  agents: Record<AgentKind, AgentChange>;
}

const TOPIC_READ_TOOLS = new Set(["list_topics", "get_topic", "list_backlinks"]);

const textOf = (content: string | readonly { type: string }[]): string =>
  typeof content === "string"
    ? content
    : content
        .map((part) => (part.type === "text" ? (part as TextContent).text : ""))
        .join("");

const resultVersion = (message: ToolResultMessage): number | null => {
  try {
    const parsed: unknown = JSON.parse(textOf(message.content));
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const version: unknown = parsed.version;
      return typeof version === "number" ? version : null;
    }
  } catch {
    return null;
  }
  return null;
};

export const applyStaleness = (
  messages: readonly Message[],
  version: number,
): Message[] =>
  messages.map((message) => {
    if (message.role !== "toolResult") return message;
    if (!TOPIC_READ_TOOLS.has(message.toolName)) return message;
    if (resultVersion(message) === version) return message;
    return {
      ...message,
      content: [{ type: "text", text: STALE_TOPIC_STUB }],
    };
  });

export const prependContext = (
  messages: readonly Message[],
  context: string,
): Message[] => {
  const index = messages.findLastIndex((message) => message.role === "user");
  if (index === -1) return [...messages];
  const user = messages[index] as UserMessage;
  const content: UserMessage["content"] =
    typeof user.content === "string"
      ? `${context}\n\n${user.content}`
      : [{ type: "text", text: context }, ...user.content];
  const out = [...messages];
  out[index] = { ...user, content };
  return out;
};

export const toolRoundsInRun = (messages: readonly Message[]): number => {
  const start = messages.findLastIndex((message) => message.role === "user");
  return messages
    .slice(start + 1)
    .filter(
      (message) =>
        message.role === "assistant" &&
        message.content.some((part) => part.type === "toolCall"),
    ).length;
};

const commonHooks = (
  deps: ZeroHarnessDeps,
  agent: AgentLabel,
  rounds: Map<ConversationId, number>,
) => [
  hook(ToolTask, {
    beforeTool: (_call, api) =>
      (rounds.get(api.conversationId) ?? 0) >= MAX_TOOL_ROUNDS
        ? { block: STEP_LIMIT_MESSAGE }
        : undefined,
  }),
  hook(GenerationTask, {
    afterResponse: async (message, api, context) => {
      if (!deps.recordUsage) return;
      const key = `zero.usage.${message.responseId ?? message.timestamp}`;
      if (await api.memo<boolean>(key, context)) return;
      await api.memo(key, true, context);
      deps.recordUsage({ conversationId: api.conversationId, agent, message });
    },
  }),
];

const declineCompaction = hook(CompactionTask, {
  beforeCompact: () => ({ decline: true }),
});

export const buildZeroRegistry = (deps: ZeroHarnessDeps): ZeroRegistry => {
  const rounds = new Map<ConversationId, number>();
  const now = deps.now ?? (() => new Date());

  const interfaceExtension: Extension = defineExtension({
    name: "zero-interface",
    sections: [
      section("prompt", () => interfaceSystemPrompt(), { tag: false }),
      section(
        "pinned",
        async () =>
          renderPinnedTopics((await deps.requestContext()).pinned).trim() ||
          undefined,
        { tag: false },
      ),
    ],
    tools: toDurableTools(TOOL_SHAPES.interface, deps.toolsets.interface),
    hooks: [
      ...commonHooks(deps, "interface", rounds),
      hook(GenerationTask, {
        beforeRequest: async (request, api) => {
          const context = await deps.requestContext();
          rounds.set(api.conversationId, toolRoundsInRun(request.messages));
          const fresh = applyStaleness(request.messages, context.knowledgeVersion);
          return {
            messages: prependContext(
              fresh,
              interfaceContext(now(), context.timezone, context.country),
            ),
          };
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, context) => {
          const stored = await api.memo<string>("zero.summary", context);
          if (stored !== undefined) return { summary: stored };
          const summary = await deps.summarize(compaction.messages);
          if (summary.trim() === "") return { decline: true };
          const kept = await api.memo("zero.summary", summary, context);
          deps.onCompaction?.(api.conversationId);
          return { summary: kept };
        },
      }),
    ],
  });

  const backgroundExtension = (
    kind: Exclude<AgentKind, "interface">,
    prompt: string,
  ): Extension =>
    defineExtension({
      name: `zero-${kind}`,
      sections: [section("prompt", () => prompt, { tag: false })],
      tools: toDurableTools(TOOL_SHAPES[kind], deps.toolsets[kind]),
      hooks: [
        ...commonHooks(deps, AGENT_LABEL[kind], rounds),
        hook(GenerationTask, {
          beforeRequest: (request, api) => {
            rounds.set(api.conversationId, toolRoundsInRun(request.messages));
            return undefined;
          },
        }),
        declineCompaction,
      ],
    });

  const extensions: Record<AgentKind, Extension> = {
    interface: interfaceExtension,
    learner: backgroundExtension("learner", learnerSystemPrompt()),
    onboarding: backgroundExtension("onboarding", onboardingSystemPrompt()),
    admin: backgroundExtension("admin", adminTaskSystemPrompt()),
  };

  const registry = createRegistry();
  for (const extension of Object.values(extensions)) registry.install(extension);

  const agentChange = (kind: AgentKind): AgentChange => {
    const choice = deps.choices(AGENT_LABEL[kind]);
    return {
      model: choice.model,
      thinkingLevel: choice.thinkingLevel,
      extensions: [extensions[kind]],
    };
  };

  const budget = deps.contextBudgetTokens ?? ZERO_CONTEXT_BUDGET_TOKENS;
  const reserveTokens = Math.max(16_384, deps.contextWindow - budget);

  return {
    registry,
    settings: {
      extensions: [interfaceExtension],
      stream: {
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
        cacheRetention: "long",
      },
      retry: deps.retry ?? { enabled: true, maxRetries: 2 },
      compaction: {
        enabled: true,
        reserveTokens,
        keepRecentTokens: Math.floor(budget / 4),
        backgroundTokens: Math.floor(budget / 4),
      },
      followUpMode: "all",
      toolExecution: "parallel",
    },
    agents: {
      interface: agentChange("interface"),
      learner: agentChange("learner"),
      onboarding: agentChange("onboarding"),
      admin: agentChange("admin"),
    },
  };
};

export const openZeroHarness = async (
  storage: Storage,
  deps: ZeroHarnessDeps,
  context: Context = BACKGROUND,
): Promise<{ harness: Harness; agents: Record<AgentKind, AgentChange> }> => {
  const { registry, settings, agents } = buildZeroRegistry(deps);
  const harness = await Harness.open(
    storage,
    { models: deps.models, registry, settings },
    context,
  );
  return { harness, agents };
};

const renderForSummary = (messages: readonly Message[]): string =>
  messages
    .flatMap((message) => {
      if (message.role === "toolResult") return [];
      const text =
        typeof message.content === "string"
          ? message.content
          : textOf(message.content);
      if (text.trim() === "") return [];
      return [`${message.role === "user" ? "User" : "Assistant"}: ${text}`];
    })
    .join("\n\n");

export const summarizeWith =
  (models: Models, choices: ModelChoices) =>
  async (messages: readonly Message[]): Promise<string> => {
    const { model: ref } = choices("compaction");
    const model = models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`Unknown compaction model: ${ref.modelId}`);
    const answer = await models.completeSimple(model, {
      systemPrompt: compactionSystemPrompt(),
      messages: [
        {
          role: "user",
          content: `# Conversation\n\n${renderForSummary(messages)}\n\nWrite the summary.`,
          timestamp: Date.now(),
        },
      ],
    });
    if (answer.stopReason === "error" || answer.stopReason === "aborted") {
      throw new Error(answer.errorMessage ?? "compaction summary failed");
    }
    return textOf(answer.content).trim();
  };
