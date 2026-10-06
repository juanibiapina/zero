import type { Api, Message as PiMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  type AgentChange,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { formatTimestamp } from "../agents/format-timestamp";
import { inferApi, toAssistantContent, toResultContent } from "./legacy-convert";
import type { ContentBlock } from "../agents/protocol";
import { log } from "../log";
import { isTerminalStopReason, messageText } from "../store/messages";
import type { MessageKind } from "../store/types";
import { BACKGROUND } from "./context";
import type { ChatRef, Ledger } from "./ledger";

export interface LegacyMessage {
  id: number;
  kind: MessageKind;
  content: ContentBlock[];
  stopReason: string | null;
  consolidated: boolean;
  createdAt: string;
}

export interface LegacyPending {
  id: number;
  content: string;
}

export interface LegacyConversation {
  id: string;
  chatId: number;
  topicId: number;
  summary: string | null;
  boundary: number | null;
  timezone: string;
  messages: LegacyMessage[];
  pending: LegacyPending[];
}

export interface ImportPlan {
  hidden: LegacyMessage[];
  handoff: string | null;
  visible: LegacyMessage[];
  resubmit: { operationId: string; text: string }[];
}

export const planImport = (conversation: LegacyConversation): ImportPlan => {
  const boundary = conversation.boundary ?? 0;
  const hidden = conversation.messages.filter(
    (message) => message.id <= boundary && !message.consolidated,
  );
  let visible = conversation.messages.filter((message) => message.id > boundary);
  const resubmit: ImportPlan["resubmit"] = [];

  const lastTerminal = visible.findLastIndex(
    (message) => message.kind === "assistant_message" && isTerminalStopReason(message.stopReason),
  );
  const owedIndex = visible.findIndex(
    (message, index) => index > lastTerminal && message.kind === "user_message",
  );
  if (owedIndex !== -1) {
    for (const message of visible.slice(owedIndex)) {
      if (message.kind !== "user_message") continue;
      resubmit.push({
        operationId: `legacy:${conversation.id}:${message.id}`,
        text: messageText(message.content),
      });
    }
    visible = visible.slice(0, owedIndex);
  }
  for (const pending of conversation.pending) {
    resubmit.push({
      operationId: `legacy:${conversation.id}:pending:${pending.id}`,
      text: pending.content,
    });
  }
  return {
    hidden,
    handoff: conversation.boundary !== null ? (conversation.summary ?? "") : null,
    visible,
    resubmit,
  };
};

const STOP_REASONS: Record<string, "stop" | "length" | "toolUse"> = {
  tool_use: "toolUse",
  max_tokens: "length",
};

const toPi = (
  message: LegacyMessage,
  timezone: string,
  toolNames: Map<string, string>,
  api: Api,
  modelId: string,
  provider: string,
): { kind: string; model: PiMessage[] }[] => {
  const timestamp = Date.parse(message.createdAt) || Date.now();
  if (message.kind === "assistant_message") {
    for (const block of message.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
    }
    return [
      {
        kind: AssistantEntry.kind,
        model: [
          {
            role: "assistant",
            content: toAssistantContent(message.content),
            api: inferApi(message.content, api),
            provider,
            model: modelId,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: STOP_REASONS[message.stopReason ?? ""] ?? "stop",
            timestamp,
          },
        ],
      },
    ];
  }
  if (message.kind === "tool_result") {
    return message.content.flatMap((block) =>
      block.type === "tool_result"
        ? [
            {
              kind: ToolResultEntry.kind,
              model: [
                {
                  role: "toolResult" as const,
                  toolCallId: block.tool_use_id,
                  toolName: toolNames.get(block.tool_use_id) ?? "",
                  content: toResultContent(block.content),
                  isError: block.is_error ?? false,
                  timestamp,
                },
              ],
            },
          ]
        : [],
    );
  }
  return [
    {
      kind: UserEntry.kind,
      model: [
        {
          role: "user",
          content: `[${formatTimestamp(message.createdAt, timezone)}] ${messageText(message.content)}`,
          timestamp,
        },
      ],
    },
  ];
};

export interface LegacySource {
  agentExportLegacy(): Promise<LegacyConversation[]> | LegacyConversation[];
}

export const IMPORTED_KEY = "legacy-imported";

export const importLegacyConversations = async (input: {
  source: LegacySource;
  pi: Harness;
  ledger: Ledger;
  agents: AgentChange;
  createSession: () => Promise<string>;
  submit: (input: {
    chat: ChatRef;
    conversationId: string;
    text: string;
    operationId: string;
  }) => Promise<void>;
}): Promise<{ imported: number }> => {
  const { pi, ledger } = input;
  if (ledger.getValue<boolean>(IMPORTED_KEY)) return { imported: 0 };
  const conversations = await input.source.agentExportLegacy();
  const model = input.agents.model;
  let imported = 0;
  for (const conversation of conversations) {
    const chat = { chatId: conversation.chatId, topicId: conversation.topicId };
    if (ledger.chat(chat)) continue;
    const plan = planImport(conversation);
    const empty =
      plan.hidden.length === 0 &&
      plan.visible.length === 0 &&
      plan.resubmit.length === 0 &&
      !plan.handoff;
    if (empty) continue;
    const session = await input.createSession();
    const id = Number(session) as ConversationId;
    const handle = await pi.conversation(id, BACKGROUND);
    await handle!.configure(input.agents, BACKGROUND);
    const toolNames = new Map<string, string>();
    const convert = (message: LegacyMessage) =>
      toPi(
        message,
        conversation.timezone,
        toolNames,
        "openai-responses",
        model?.modelId ?? "",
        model?.provider ?? "",
      );
    const consolidatedPrefix =
      plan.hidden.length === 0
        ? (plan.visible.filter((message) => message.consolidated).at(-1)?.id ?? 0)
        : 0;
    const { consolidatedThrough, last } = await pi.commit(async (tx) => {
      let last = 0;
      let consolidatedThrough = 0;
      const append = async (message: LegacyMessage) => {
        for (const draft of convert(message)) last = (await tx.appendEntry(id, draft)).id;
        if (message.id === consolidatedPrefix) consolidatedThrough = last;
      };
      for (const message of plan.hidden) await append(message);
      if (plan.handoff !== null) {
        last = (
          await tx.appendEntry(id, {
            kind: ResetEntry.kind,
            head: "self",
            ...(plan.handoff.trim()
              ? {
                  model: [
                    {
                      role: "user",
                      content: `[summary of earlier conversation]\n\n${plan.handoff}`,
                      timestamp: Date.now(),
                    },
                  ],
                }
              : {}),
          })
        ).id;
      }
      for (const message of plan.visible) await append(message);
      return { consolidatedThrough, last };
    }, BACKGROUND);
    ledger.addChat({ ...chat, conversationId: conversation.id, session });
    ledger.setSentThrough(session, last);
    if (consolidatedThrough > 0) ledger.setConsolidatedThrough(session, consolidatedThrough);
    for (const owed of plan.resubmit) {
      await input.submit({ chat, conversationId: conversation.id, text: owed.text, operationId: owed.operationId });
    }
    imported++;
  }
  ledger.putValue(IMPORTED_KEY, true);
  log("legacy_import_completed", { conversations: conversations.length, imported });
  return { imported };
};
