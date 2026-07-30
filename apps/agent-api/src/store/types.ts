// Storage ports for the meta-agent system. The agents and the turn
// orchestrator depend only on these interfaces, never on do-orm or the DO.
// Two adapters implement them: `DbStore` (do-orm over DO SQLite, prod) and
// `MemoryStore` (in-memory, tests). See store/store-contract.test.ts.

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
  // ISO-8601 creation time; used to render each message's relative age.
  createdAt: string;
}

// Topic listing metadata (no body).
export interface TopicMeta {
  name: string;
  description: string;
  lastActiveAt: string;
  messageCount: number;
  // Pinned topics are always surfaced in the interface agent's prompt.
  pinned: boolean;
  // System topics are read-only reference documents bundled with the Worker
  // (see store/system-topics.ts). They live in no user's SQLite; the
  // SystemTopicStore decorator overlays them onto reads and rejects writes.
  // Real DB adapters always return false; only the decorator sets it true.
  system: boolean;
}

// Full topic including the knowledge document body.
export interface Topic extends TopicMeta {
  body: string;
  createdAt: string;
}

// A conversation thread awaiting processing.
export interface Thread {
  id: string;
  chatId: number;
  topicId: number;
}

// An attachment the user sent. Bytes live in R2 under `r2Key`; this row is the
// lookup-by-id record so view_attachment can resolve an id referenced from any
// past turn. `id` is embedded in the message marker text.
export interface Attachment {
  id: string;
  conversationId: string;
  r2Key: string;
  filename: string;
  mimeType: string;
  createdAt: string;
}

export interface TopicStore {
  listTopics(): TopicMeta[];
  getTopic(name: string): Topic | null;
  createTopic(name: string, description: string): void;
  // Delete a topic. Its own outbound link rows go; inbound links from other
  // bodies become dangling (their [[Name]] tokens are left untouched). Throws
  // if the topic does not exist.
  deleteTopic(name: string): void;
  updateTopicBody(name: string, body: string): void;
  getTopicsWithBodies(names: string[]): Topic[];
  // Pin or unpin a topic. Pinned topics are always rendered into the interface
  // agent's prompt. Pinning survives a saveTopic rename.
  setPinned(name: string, pinned: boolean): void;
  // Full bodies of every pinned topic, for prompt surfacing.
  getPinnedTopics(): Topic[];
  saveTopic(
    name: string,
    patch: { body: string; description: string },
    newName?: string,
  ): void;
  // Target names this topic links to via `[[Name]]` (distinct, includes
  // dangling links whose target does not exist yet).
  getOutboundLinks(name: string): string[];
  // Topics whose body links to `name` (its back-references).
  getBacklinks(name: string): TopicMeta[];
}

export interface ConversationStore {
  getOrCreateConversation(chatId: number, topicId: number): string;
  storeMessage(conversationId: string, role: Role, content: string): void;
  getConversationHistory(conversationId: string, limit: number): Message[];
  resetConversation(chatId: number, topicId: number): void;
  findThreadsAwaitingReply(): Thread[];
}

// Attachment metadata rows, keyed by the id embedded in the message marker.
export interface AttachmentRecordStore {
  putAttachment(attachment: {
    id: string;
    conversationId: string;
    r2Key: string;
    filename: string;
    mimeType: string;
  }): void;
  getAttachment(id: string): Attachment | null;
}

// The per-user settings row, as reported to callers. Nullable columns come
// through as null; `isNewUser` marks the access that seeded the row.
export interface UserSettings {
  onboardingSeen: boolean;
  googleOnboardingStatus: string | null;
  createdAt: string | null;
  timezone: string | null;
  // True only on the access that seeded the row (first-ever getSettings).
  isNewUser: boolean;
}

// Per-user identity, settings, and webhook idempotency. Single-row tables
// (telegram_link, user_settings) plus the processed_updates dedupe log.
export interface SettingsStore {
  // Seeds the settings row on first access; isNewUser is true only then.
  getSettings(): UserSettings;
  updateSettings(patch: { onboardingSeen?: boolean; timezone?: string }): void;
  setGoogleOnboardingStatus(status: string): void;

  getTelegramId(): string | null;
  linkTelegram(telegramId: string): { previous: string | null };
  // Removes the link row only; R2 attachment purge is the DO's job.
  unlinkTelegram(): { removed: string | null };

  // Record an update id; true if newly seen, false if already processed.
  markProcessed(updateId: string): boolean;
}

export type Store = TopicStore &
  ConversationStore &
  AttachmentRecordStore &
  SettingsStore;
