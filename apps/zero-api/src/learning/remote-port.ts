// LearningPort over a UserDO stub: the production adapter, used by LearningDO.
//
// The only real work here is undoing the RPC boundary's two effects: a write
// result becomes a thrown KnowledgeConflictError again (so the topic tools see
// the same conflict they see in a turn), and every read is awaited.

import { KnowledgeConflictError } from "../store/types";
import type {
  LearningMessage,
  Topic,
  TopicMeta,
  TopicToolStore,
} from "../store/types";
import type { LearningPort, TopicWriteResult } from "./types";

// The UserDO methods this adapter needs. Declared structurally so the module
// does not depend on the Durable Object class itself.
export interface LearningRpc {
  learnBeginJob(jobId: string): Promise<number> | number;
  learnListMessages(input: {
    throughMessageId: number;
    afterId?: number;
    limit: number;
  }): Promise<LearningMessage[]> | LearningMessage[];
  learnCompleteJob(jobId: string, throughMessageId: number): Promise<void> | void;
  learnGetCompactionWindow(
    conversationId: string,
    limit: number,
  ):
    | Promise<{
        summary: string | null;
        messages: LearningMessage[];
        hasMore: boolean;
      }>
    | { summary: string | null; messages: LearningMessage[]; hasMore: boolean };
  learnCompactConversation(
    conversationId: string,
    input: { throughMessageId: number; summary: string },
  ): Promise<void> | void;
  learnKnowledgeVersion(): Promise<number> | number;
  learnListTopics(): Promise<TopicMeta[]> | TopicMeta[];
  learnGetTopic(name: string): Promise<Topic | null> | Topic | null;
  learnGetOutboundLinks(name: string): Promise<string[]> | string[];
  learnGetBacklinks(name: string): Promise<TopicMeta[]> | TopicMeta[];
  learnCreateTopic(input: {
    expectedVersion: number;
    name: string;
    description: string;
    body: string;
  }): Promise<TopicWriteResult> | TopicWriteResult;
  learnUpdateTopicBody(input: {
    expectedVersion: number;
    name: string;
    body: string;
  }): Promise<TopicWriteResult> | TopicWriteResult;
  learnUpdateTopicMetadata(input: {
    expectedVersion: number;
    name: string;
    description?: string;
    newName?: string;
  }): Promise<TopicWriteResult> | TopicWriteResult;
  learnDeleteTopic(input: {
    expectedVersion: number;
    name: string;
  }): Promise<TopicWriteResult> | TopicWriteResult;
}

// Rebuild the local failure from the transported result. A conflict must arrive
// as a KnowledgeConflictError or the tools would report it as an ordinary error
// and the model would not know to reread.
const unwrap = (result: TopicWriteResult): number => {
  if ("version" in result) return result.version;
  if ("conflict" in result)
    throw new KnowledgeConflictError(
      result.conflict.expected,
      result.conflict.current,
    );
  throw new Error(result.failed);
};

export const createRemoteLearningPort = (rpc: LearningRpc): LearningPort => {
  const topics: TopicToolStore = {
    getKnowledgeVersion: () => rpc.learnKnowledgeVersion(),
    listTopics: () => rpc.learnListTopics(),
    getTopic: (name) => rpc.learnGetTopic(name),
    getOutboundLinks: (name) => rpc.learnGetOutboundLinks(name),
    getBacklinks: (name) => rpc.learnGetBacklinks(name),
    createTopic: async (input) => unwrap(await rpc.learnCreateTopic(input)),
    updateTopicBody: async (input) =>
      unwrap(await rpc.learnUpdateTopicBody(input)),
    updateTopicMetadata: async (input) =>
      unwrap(await rpc.learnUpdateTopicMetadata(input)),
    deleteTopic: async (input) => unwrap(await rpc.learnDeleteTopic(input)),
  };

  return {
    topics,
    beginJob: async (jobId) => rpc.learnBeginJob(jobId),
    listMessages: async (input) => rpc.learnListMessages(input),
    completeJob: async (jobId, throughMessageId) =>
      void (await rpc.learnCompleteJob(jobId, throughMessageId)),
    getCompactionWindow: async (conversationId, limit) =>
      rpc.learnGetCompactionWindow(conversationId, limit),
    compactConversation: async (conversationId, input) =>
      void (await rpc.learnCompactConversation(conversationId, input)),
  };
};
