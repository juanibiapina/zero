// Turn orchestrator: the in-process glue between the two agents and the store.
// Runtime-agnostic — it knows nothing about alarms, Durable Objects, or
// Telegram, only the Store, a model, and a reply sink. The DO calls this from
// its alarm handler; tests call it directly with MemoryStore + a scripted model.

import { runInterfaceAgent } from "./interface";
import { runWriterAgent } from "./writer";
import type { LanguageModel } from "ai";
import type { Store } from "../store/types";

const DEFAULT_HISTORY_LIMIT = 20;

export interface TurnInput {
  store: Store;
  model: LanguageModel;
  send: (text: string) => Promise<void>;
  chatId: number;
  topicId: number;
  historyLimit?: number;
}

// Process one awaiting-reply thread: run the interface agent (which sends
// replies live), persist those replies, then consolidate any accessed topics
// via the writer. The tail of history must be the user message being answered.
export const runTurn = async (input: TurnInput): Promise<void> => {
  const { store, model, send, chatId, topicId } = input;
  const limit = input.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  const conversationId = store.getOrCreateConversation(chatId, topicId);
  const all = store.getConversationHistory(conversationId, limit);
  const last = all[all.length - 1];
  if (!last || last.role !== "user") return;

  const userMessage = last.content;
  const history = all.slice(0, -1);

  store.markBusy(conversationId);
  try {
    const { replies, accessed } = await runInterfaceAgent({
      model,
      store,
      send,
      history,
      userMessage,
    });

    for (const reply of replies) {
      store.storeMessage(conversationId, "assistant", reply);
    }

    if (accessed.length > 0) {
      const topics = store.getTopicsWithBodies(accessed);
      await runWriterAgent({
        model,
        store,
        topics,
        exchange: { user: userMessage, assistant: replies },
      });
    }
  } finally {
    store.clearBusy(conversationId);
  }
};
