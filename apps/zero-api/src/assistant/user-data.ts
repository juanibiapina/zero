import type { FileListInput, FilePage, StoredFile, UserFileStore } from "../files/types";
import type { MailWatchBook, WatchResult, WatchedThread } from "../mail-watch/types";
import type { CreateScheduleResult, Schedule, ScheduleBook } from "../schedules/types";
import {
  KnowledgeConflictError,
  type Topic,
  type TopicMeta,
  type TopicToolStore,
} from "../store/types";
import type { RequestContext } from "./harness";

export type TopicWriteResult =
  | { version: number }
  | { conflict: { expected: number; current: number } }
  | { failed: string };

export interface UserSettingsView {
  timezone: string | null;
  country: string | null;
  braveKeyPaid: boolean;
}

type Rpc<T> = T | Promise<T>;

export interface UserDataRpc {
  agentRequestContext(): Rpc<RequestContext>;
  agentSettings(): Rpc<UserSettingsView>;
  agentSetTimezone(timezone: string): Rpc<void>;
  agentSetCountry(country: string): Rpc<void>;
  agentKnowledgeVersion(): Rpc<number>;
  agentListTopics(): Rpc<TopicMeta[]>;
  agentGetTopic(name: string): Rpc<Topic | null>;
  agentGetOutboundLinks(name: string): Rpc<string[]>;
  agentGetBacklinks(name: string): Rpc<TopicMeta[]>;
  agentCreateTopic(input: {
    expectedVersion: number;
    name: string;
    description: string;
    body: string;
  }): Rpc<TopicWriteResult>;
  agentUpdateTopicBody(input: {
    expectedVersion: number;
    name: string;
    body: string;
  }): Rpc<TopicWriteResult>;
  agentUpdateTopicMetadata(input: {
    expectedVersion: number;
    name: string;
    description?: string;
    newName?: string;
  }): Rpc<TopicWriteResult>;
  agentDeleteTopic(input: { expectedVersion: number; name: string }): Rpc<TopicWriteResult>;
  agentCreateSchedule(
    conversationId: string,
    input: { prompt: string; pattern: string; timezone: string },
  ): Rpc<CreateScheduleResult>;
  agentListSchedules(conversationId: string): Rpc<Schedule[]>;
  agentCancelSchedule(conversationId: string, id: string): Rpc<boolean>;
  agentWatchThread(conversationId: string, threadId: string): Rpc<WatchResult>;
  agentListWatchedThreads(conversationId: string): Rpc<WatchedThread[]>;
  agentStopWatching(conversationId: string, threadId: string): Rpc<boolean>;
  agentSaveFile(input: { filename: string; mimeType: string; bytes: Uint8Array }): Rpc<StoredFile>;
  agentGetFile(id: string): Rpc<StoredFile | null>;
  agentReadFile(id: string): Rpc<Uint8Array | null>;
  agentListFiles(input: FileListInput): Rpc<FilePage>;
  agentDeleteFile(id: string): Rpc<boolean>;
}

export interface UserDataPort {
  topics: TopicToolStore;
  requestContext(): Promise<RequestContext>;
  settings(): Promise<UserSettingsView>;
  setTimezone(timezone: string): Promise<void>;
  setCountry(country: string): Promise<void>;
  schedules(conversationId: string): ScheduleBook;
  mailWatch(conversationId: string): MailWatchBook;
  files: UserFileStore;
}

const unwrap = (result: TopicWriteResult): number => {
  if ("version" in result) return result.version;
  if ("conflict" in result) {
    throw new KnowledgeConflictError(result.conflict.expected, result.conflict.current);
  }
  throw new Error(result.failed);
};

export const toWriteResult = (apply: () => number): TopicWriteResult => {
  try {
    return { version: apply() };
  } catch (err) {
    if (err instanceof KnowledgeConflictError) {
      return { conflict: { expected: err.expected, current: err.current } };
    }
    return { failed: err instanceof Error ? err.message : String(err) };
  }
};

export const createRemoteUserData = (rpc: UserDataRpc): UserDataPort => ({
  topics: {
    getKnowledgeVersion: () => rpc.agentKnowledgeVersion(),
    listTopics: () => rpc.agentListTopics(),
    getTopic: (name) => rpc.agentGetTopic(name),
    getOutboundLinks: (name) => rpc.agentGetOutboundLinks(name),
    getBacklinks: (name) => rpc.agentGetBacklinks(name),
    createTopic: async (input) => unwrap(await rpc.agentCreateTopic(input)),
    updateTopicBody: async (input) => unwrap(await rpc.agentUpdateTopicBody(input)),
    updateTopicMetadata: async (input) => unwrap(await rpc.agentUpdateTopicMetadata(input)),
    deleteTopic: async (input) => unwrap(await rpc.agentDeleteTopic(input)),
  },
  requestContext: async () => rpc.agentRequestContext(),
  settings: async () => rpc.agentSettings(),
  setTimezone: async (timezone) => rpc.agentSetTimezone(timezone),
  setCountry: async (country) => rpc.agentSetCountry(country),
  schedules: (conversationId) => ({
    create: async (input) => rpc.agentCreateSchedule(conversationId, input),
    list: async () => rpc.agentListSchedules(conversationId),
    cancel: async (id) => rpc.agentCancelSchedule(conversationId, id),
  }),
  mailWatch: (conversationId) => ({
    watch: async (threadId) => rpc.agentWatchThread(conversationId, threadId),
    list: async () => rpc.agentListWatchedThreads(conversationId),
    stop: async (threadId) => rpc.agentStopWatching(conversationId, threadId),
  }),
  files: {
    save: async (input) => rpc.agentSaveFile(input),
    get: async (id) => rpc.agentGetFile(id),
    read: async (id) => rpc.agentReadFile(id),
    list: async (input) => rpc.agentListFiles(input),
    delete: async (id) => rpc.agentDeleteFile(id),
    deleteAll: async () => {
      throw new Error("deleteAll is not available to the agent");
    },
  },
});
