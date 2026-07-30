// Test-only helpers over the versioned topic writes. Every Store write states
// the knowledge version it was based on; tests that are not about versioning
// read the current version and write against it, which is what these do. Tests
// that ARE about versioning call the store directly with an explicit version.

import { defaultKind } from "./messages";
import type { Message, MessageContent, Role, TopicStore } from "./types";

// A history row for tests that only care about role, content and time. The
// protocol fields (id, kind, stopReason) get the values the store would write
// for a finished message.
export const historyMessage = (
  role: Role,
  content: MessageContent,
  createdAt: string,
  overrides: Partial<Message> = {},
): Message => ({
  id: 0,
  role,
  kind: defaultKind(role),
  content,
  stopReason: role === "assistant" ? "end_turn" : null,
  createdAt,
  ...overrides,
});

export const seedTopic = (
  store: TopicStore,
  name: string,
  description = "",
  body = "",
): number =>
  store.createTopic({
    expectedVersion: store.getKnowledgeVersion(),
    name,
    description,
    body,
  });

export const setBody = (
  store: TopicStore,
  name: string,
  body: string,
): number =>
  store.updateTopicBody({
    expectedVersion: store.getKnowledgeVersion(),
    name,
    body,
  });

export const setDescription = (
  store: TopicStore,
  name: string,
  description: string,
): number =>
  store.updateTopicMetadata({
    expectedVersion: store.getKnowledgeVersion(),
    name,
    description,
  });

export const renameTopic = (
  store: TopicStore,
  name: string,
  newName: string,
): number =>
  store.updateTopicMetadata({
    expectedVersion: store.getKnowledgeVersion(),
    name,
    newName,
  });

export const removeTopic = (store: TopicStore, name: string): number =>
  store.deleteTopic({ expectedVersion: store.getKnowledgeVersion(), name });

export const pinTopic = (
  store: TopicStore,
  name: string,
  pinned = true,
): number =>
  store.setPinned({
    expectedVersion: store.getKnowledgeVersion(),
    name,
    pinned,
  });
