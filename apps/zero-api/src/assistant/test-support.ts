import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  type AgentChange,
  type ConversationId,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createMemoryGoogle } from "../google/memory";
import { createMemoryFetcher } from "../pagefetch/memory";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";
import type { AgentToolSet } from "../agents/protocol";
import {
  createAssistant,
  type Assistant,
  type AssistantHost,
  type OperationResult,
} from "./assistant";
import { BACKGROUND } from "./context";
import { openZeroHarness, type AgentKind } from "./harness";
import { createMemoryLedger, type ChatRef, type Ledger } from "./ledger";
import {
  adminToolset,
  interfaceToolset,
  learnerToolset,
  onboardingToolset,
  type InterfaceToolContext,
} from "./toolsets";

export interface Sent {
  chat: ChatRef;
  text: string;
}

export interface TestAssistant {
  assistant: Assistant;
  harness: Harness;
  agents: Record<AgentKind, AgentChange>;
  createSession: () => Promise<string>;
  ledger: Ledger;
  store: MemoryStore;
  sent: Sent[];
  failSends: { remaining: number };
  script: (steps: FauxResponseStep[]) => void;
  requests: () => number;
  idle: () => Promise<void>;
  reopen: () => Promise<TestAssistant>;
  close: () => Promise<void>;
}

export interface TestAssistantOptions {
  storage?: Storage;
  openStorage?: () => Promise<Storage>;
  store?: MemoryStore;
  ledger?: Ledger;
  sent?: Sent[];
  steps?: FauxResponseStep[];
  interface?: Partial<InterfaceToolContext>;
  contextBudgetTokens?: number;
  toolsets?: Partial<Record<AgentKind, () => AgentToolSet>>;
}

export const createTestAssistant = async (
  options: TestAssistantOptions = {},
): Promise<TestAssistant> => {
  const storage =
    options.storage ?? (options.openStorage ? await options.openStorage() : new MemoryStorage());
  const store = options.store ?? new MemoryStore();
  const ledger = options.ledger ?? createMemoryLedger();
  const sent = options.sent ?? [];
  const failSends = { remaining: 0 };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(options.steps ?? []);
  const model = faux.getModel();

  const google = createMemoryGoogle();
  const toolsets: Record<AgentKind, () => AgentToolSet> = {
    interface: () =>
      interfaceToolset({
        topics: store,
        search: createMemorySearch(),
        fetcher: createMemoryFetcher(),
        google,
        timezone: "UTC",
        ...options.interface,
      }),
    learner: () => learnerToolset(store),
    admin: () => adminToolset(store),
    onboarding: () => onboardingToolset(store, google),
    ...options.toolsets,
  };

  const { harness, agents } = await openZeroHarness(storage, {
    models,
    choices: () => ({
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel: "high",
    }),
    toolsets: {
      interface: async () => toolsets.interface(),
      learner: async () => toolsets.learner(),
      admin: async () => toolsets.admin(),
      onboarding: async () => toolsets.onboarding(),
    },
    requestContext: async () => ({
      knowledgeVersion: store.getKnowledgeVersion(),
      pinned: store.getPinnedTopics(),
      timezone: "UTC",
    }),
    summarize: async () => "summary of the earlier conversation",
    contextWindow: model.contextWindow,
    contextBudgetTokens: options.contextBudgetTokens,
    retry: { enabled: false },
  });

  const conversation = async (session: string) => {
    const found = await harness.conversation(Number(session) as ConversationId, BACKGROUND);
    if (!found) throw new Error(`unknown session ${session}`);
    return found;
  };

  const host: AssistantHost = {
    pi: async () => harness,
    agents: async () => agents,
    createSession: async (change) =>
      String(
        (
          await harness.createConversation(
            { ownership: { kind: "ownerless" }, agent: change },
            BACKGROUND,
          )
        ).id,
      ),
    submit: async (session, text, operationId) => {
      await (await conversation(session)).submit(
        { type: "input", content: text, requestId: operationId },
        BACKGROUND,
      );
    },
    wait: async (session, operationId): Promise<OperationResult> => {
      const record = await harness.commit(
        (tx) => tx.submissionByRequest(Number(session) as ConversationId, operationId),
        BACKGROUND,
      );
      if (!record) return { status: "unanswered", reason: "not_found" };
      const submission = await harness.submission(record.id, BACKGROUND);
      const settled = await submission!.wait(BACKGROUND);
      if (settled.status !== "done" || settled.type !== "input") {
        return { status: "unanswered", reason: settled.status === "unanswered" ? settled.reason : undefined };
      }
      const answer = await harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND);
      const message = answer?.model?.[0];
      const text =
        message?.role === "assistant"
          ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
          : "";
      return { status: "done", text };
    },
    reset: async (session) => (await conversation(session)).reset(undefined, BACKGROUND),
    scheduleCheck: async () => {},
  };

  const assistant = createAssistant({
    host,
    ledger,
    telegram: {
      send: async (chat, text) => {
        if (failSends.remaining > 0) {
          failSends.remaining--;
          throw new Error("telegram down");
        }
        sent.push({ chat: { chatId: chat.chatId, topicId: chat.topicId }, text });
      },
      typing: async () => {},
    },
  });
  await assistant.start();

  const idle = async () => {
    for (let i = 0; i < 20; i++) {
      await harness.waitForIdle(BACKGROUND);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await assistant.check();
      if (ledger.operations().length === 0) return;
    }
  };

  const self: TestAssistant = {
    assistant,
    harness,
    agents,
    createSession: () => host.createSession(agents.interface),
    ledger,
    store,
    sent,
    failSends,
    script: (steps) => faux.setResponses(steps),
    requests: () => faux.state.callCount,
    idle,
    reopen: async () => {
      await harness.close(BACKGROUND);
      return createTestAssistant({
        ...options,
        storage: options.openStorage ? undefined : storage,
        store,
        ledger,
        sent,
      });
    },
    close: () => harness.close(BACKGROUND),
  };
  return self;
};
