// LearningPort over a local Store. Used by tests (MemoryStore) and by UserDO
// itself, which implements the RPC surface by calling straight through it, so
// both adapters run the same code path into the store.

import type { LearningMessage, Store } from "../store/types";
import type { LearningPort } from "./types";

export const createStoreLearningPort = (store: Store): LearningPort => ({
  topics: store,
  beginJob: async (jobId: string): Promise<number> =>
    store.beginLearningJob(jobId),
  listMessages: async (input: {
    throughMessageId: number;
    afterId?: number;
    limit: number;
  }): Promise<LearningMessage[]> => store.listUnconsolidatedMessages(input),
  completeJob: async (jobId: string, throughMessageId: number): Promise<void> =>
    store.completeLearningJob(jobId, throughMessageId),
  getCompactionWindow: async (
    conversationId: string,
    limit: number,
  ): Promise<{
    summary: string | null;
    messages: LearningMessage[];
    hasMore: boolean;
  }> => {
    const window = store.getCompactionWindow(conversationId, limit);
    return {
      summary: window.summary,
      messages: window.messages.map((m) => ({ ...m, conversationId })),
      hasMore: window.hasMore,
    };
  },
  compactConversation: async (
    conversationId: string,
    input: { throughMessageId: number; summary: string },
  ): Promise<void> => store.compactConversation(conversationId, input),
});
