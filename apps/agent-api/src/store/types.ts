// Storage ports for the meta-agent system. The agents and the turn
// orchestrator depend only on these interfaces, never on do-orm or the DO.
// Two adapters implement them: `DbStore` (do-orm over DO SQLite, prod) and
// `MemoryStore` (in-memory, tests). See store/store-contract.test.ts.
//
// Conversation content is the agent protocol's own wire format: messages are
// stored as content blocks, verbatim, so tool calls and results survive
// between turns. protocol.ts is dependency-free, so this stays a port.

import type { ContentBlock } from "../agents/protocol";

export type Role = "user" | "assistant";

// What a stored row is, independent of its wire role. `tool_result` rows carry
// the `user` role on the wire but are not something the user said.
export type MessageKind = "user_message" | "assistant_message" | "tool_result";

// Message content: wire-format blocks, or a plain string as a shorthand for a
// single text block. Storage always persists blocks.
export type MessageContent = string | ContentBlock[];

export interface Message {
  // Row id. Delivery records are keyed by it, so callers that send text need it.
  id: number;
  role: Role;
  kind: MessageKind;
  content: MessageContent;
  // Why the model ended this response (Anthropic's own reason, verbatim). Null
  // for user rows and for rows written before the reason was recorded.
  stopReason: string | null;
  // The model's own id for this response. Null for user rows and for rows
  // written before it was recorded; the newest non-null one is what the next
  // request chains its cache diagnostics to.
  responseId: string | null;
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

// A conversation as the model should see it: the compacted prefix as prose,
// then the messages that survive the boundary.
export interface ConversationContext {
  // Summary of everything up to the compaction boundary, or null when the
  // conversation has never been compacted.
  summary: string | null;
  messages: Message[];
}

// One compaction pass's input: the oldest rows after the boundary, the summary
// they extend, and whether the window stopped short of the conversation's tail.
// `hasMore` is what tells a pass to hand the rest to a successor instead of
// pretending it saw the whole conversation.
export interface CompactionWindow {
  summary: string | null;
  messages: Message[];
  hasMore: boolean;
}

// A conversation thread awaiting processing.
export interface Thread {
  id: string;
  chatId: number;
  topicId: number;
}

// User-owned file metadata. Bytes live in R2 under storageKey. Legacy records
// may have an unknown byte size until file-store quota enforcement backfills it.
export interface StoredFileRecord {
  id: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  byteSize: number | null;
  createdAt: string;
}


// Raised when a write is based on a knowledge version that is no longer
// current: something else changed a topic since the caller read one. The caller
// rereads and retries; nothing is written. Agents see it as a tool error.
export class KnowledgeConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly current: number,
  ) {
    super(
      `knowledge changed since you read it (you used version ${expected}, current is ${current}): reread the topic and retry`,
    );
    this.name = "KnowledgeConflictError";
  }
}

// One integer per user covering every topic body, the catalog and the link
// graph. Reads report it; writes state the version they were based on and fail
// on a mismatch. Deliberately coarse: one rule for all topic knowledge.
export interface TopicStore {
  getKnowledgeVersion(): number;
  listTopics(): TopicMeta[];
  getTopic(name: string): Topic | null;
  // Create a complete topic (body included) in one step. Throws if the name is
  // taken.
  createTopic(input: {
    expectedVersion: number;
    name: string;
    description: string;
    body: string;
  }): number;
  // Delete a topic. Its own outbound link rows go; inbound links from other
  // bodies become dangling (their [[Name]] tokens are left untouched). Throws
  // if the topic does not exist.
  deleteTopic(input: { expectedVersion: number; name: string }): number;
  updateTopicBody(input: {
    expectedVersion: number;
    name: string;
    body: string;
  }): number;
  // Description and/or rename. Never touches the body.
  updateTopicMetadata(input: {
    expectedVersion: number;
    name: string;
    description?: string;
    newName?: string;
  }): number;
  getTopicsWithBodies(names: string[]): Topic[];
  // Pin or unpin a topic. Pinned topics are always rendered into the interface
  // agent's prompt. Pinning survives a rename.
  setPinned(input: {
    expectedVersion: number;
    name: string;
    pinned: boolean;
  }): number;
  // Full bodies of every pinned topic, for prompt surfacing.
  getPinnedTopics(): Topic[];
  // Bundled system topics live in no user's SQLite, so a Worker build that
  // changes their text must still invalidate persisted reads of them. Store the
  // fingerprint of the bundled content; bump the version once when it differs.
  syncSystemTopicsFingerprint(fingerprint: string): number;
  // Target names this topic links to via `[[Name]]` (distinct, includes
  // dangling links whose target does not exist yet).
  getOutboundLinks(name: string): string[];
  // Topics whose body links to `name` (its back-references).
  getBacklinks(name: string): TopicMeta[];
}

// A value that may arrive later. The topic tools are written against this so
// one tool module serves both transports: a local `TopicStore` inside a turn,
// and a remote learning port that reaches another Durable Object.
export type Awaitable<T> = T | Promise<T>;

// Exactly the topic surface the tools use, sync or async. `TopicStore`
// satisfies it structurally, so nothing at the turn path changes.
export interface TopicToolStore {
  getKnowledgeVersion(): Awaitable<number>;
  listTopics(): Awaitable<TopicMeta[]>;
  getTopic(name: string): Awaitable<Topic | null>;
  getOutboundLinks(name: string): Awaitable<string[]>;
  getBacklinks(name: string): Awaitable<TopicMeta[]>;
  createTopic(input: {
    expectedVersion: number;
    name: string;
    description: string;
    body: string;
  }): Awaitable<number>;
  updateTopicBody(input: {
    expectedVersion: number;
    name: string;
    body: string;
  }): Awaitable<number>;
  updateTopicMetadata(input: {
    expectedVersion: number;
    name: string;
    description?: string;
    newName?: string;
  }): Awaitable<number>;
  deleteTopic(input: { expectedVersion: number; name: string }): Awaitable<number>;
}

export interface ConversationStore {
  getOrCreateConversation(chatId: number, topicId: number): string;
  // Append one row to the transcript and return its id. `kind` defaults from
  // the role; `stopReason` defaults to "end_turn" for an assistant row, which
  // is what a caller that persists a finished reply means.
  storeMessage(
    conversationId: string,
    role: Role,
    content: MessageContent,
    options?: {
      kind?: MessageKind;
      stopReason?: string | null;
      responseId?: string | null;
    },
  ): number;
  getConversationHistory(conversationId: string, limit: number): Message[];
  // What the model should see: the summary of the compacted prefix (null until
  // this conversation has been compacted) plus up to `limit` of the newest
  // messages after the boundary. The raw rows before the boundary stay in
  // storage for learning; only the rendered context skips them.
  getConversationContext(
    conversationId: string,
    limit: number,
  ): ConversationContext;
  // What compaction reads: the OLDEST `limit` rows after the boundary, plus
  // whether more follow. It pages forward on purpose. Reading the newest rows
  // instead (what the turn does) and then moving the boundary to the end of
  // that window would jump the boundary over every row in between, and those
  // rows would never enter any summary.
  getCompactionWindow(
    conversationId: string,
    limit: number,
  ): CompactionWindow;
  // Move the compaction boundary and store the summary covering everything up
  // to and including `throughMessageId`. Deletes nothing.
  compactConversation(
    conversationId: string,
    input: { throughMessageId: number; summary: string },
  ): void;
  resetConversation(chatId: number, topicId: number): void;
  // Queue a Telegram message for this conversation. It enters the transcript
  // only when a turn drains the queue, so a message arriving mid-run is never
  // spliced into a request the model is already answering.
  enqueuePendingMessage(conversationId: string, content: string): void;
  // Move every queued message for this conversation into the transcript, in
  // arrival order, in one transaction, and return the rows inserted. Atomic so
  // a reset can neither lose a message nor inject it twice.
  drainPendingMessages(conversationId: string): Message[];
  // Claim one assistant text block for delivery. True the first time, false if
  // it was already claimed: a resumed run must not send it again.
  claimDelivery(messageId: number, blockIndex: number): boolean;
  // How many text blocks of this row were persisted and never sent. Zero for a
  // fully delivered row, for a row with no text, and for any row at or below the
  // conversation's delivery watermark. It is what tells a finished response
  // apart from one that was only written down, which is the difference between
  // an idle conversation and a lost reply.
  countUndeliveredBlocks(messageId: number): number;
  // Declare every message up to `messageId` delivered without a claim. Rows
  // written before delivery claims existed have none, and without this they read
  // as "persisted but never sent" and would be sent again. Production sets it
  // once, in migration 0029; this is the same statement, for tests.
  markDeliveredThrough(conversationId: string, messageId: number): void;
  // Conversations that still owe work: a queued message, a tail awaiting a
  // model response, or a response that stopped for a non-terminal reason.
  findConversationsWithWork(): Thread[];
}

// What a claim on an irreversible external call says about it.
//
// - `claimed`: nobody had this call; the caller owns it and must run it.
// - `in_flight`: an earlier attempt claimed it and never recorded an outcome, so
//   the request may or may not have left. It must NOT be repeated.
// - `completed`: it returned, and `result` is what it returned.
export type ExternalCallClaim =
  | { status: "claimed" }
  | { status: "in_flight" }
  | { status: "completed"; result: string };

// Durable at-most-once bookkeeping for calls that cannot be replayed (sending
// mail, creating a calendar event), keyed by the model's own `tool_use` id so a
// resumed turn replaying the same response lands on the same row.
export interface ExternalCallStore {
  beginExternalCall(toolUseId: string, tool: string): ExternalCallClaim;
  completeExternalCall(toolUseId: string, result: string): void;
}

// A raw log row as learning reads it: the same message, plus which conversation
// it belongs to (learning reads across all of them, a turn reads one).
export interface LearningMessage extends Message {
  conversationId: string;
}

// The raw-log side of learning. Topic reads and writes are the ordinary
// versioned TopicStore methods; this is only the message bookkeeping a job needs.
export interface LearningStore {
  // Start (or re-attach to) a job and return the newest message id it covers.
  // Calling it again with the same job id returns the same frozen number, so a
  // restarted job never widens its own range.
  beginLearningJob(jobId: string): number;
  // Unconsolidated messages in id order, up to the job's high-water mark.
  // `afterId` pages forward; the caller stops when a page comes back short.
  listUnconsolidatedMessages(input: {
    throughMessageId: number;
    afterId?: number;
    limit: number;
  }): LearningMessage[];
  // Stamp the job's messages as consolidated, in one transaction, up to
  // `throughMessageId` (defaulting to the job's high-water mark) and never past
  // the high-water mark. A job that was handed only part of its range passes
  // what it actually read, so the rest stays available to a successor.
  // Idempotent by job id: a repeated call after a lost acknowledgement does
  // nothing.
  completeLearningJob(jobId: string, throughMessageId?: number): void;
}

// Metadata seam used only by UserFileStore. It stays synchronous because it is
// backed by the current user's Durable Object SQLite database.
export interface FileRecordStore {
  putFile(file: {
    id: string;
    storageKey: string;
    filename: string;
    mimeType: string;
    byteSize: number | null;
  }): StoredFileRecord;
  getFile(id: string): StoredFileRecord | null;
  listFiles(): StoredFileRecord[];
  updateFileSize(id: string, byteSize: number): void;
  deleteFile(id: string): void;
  deleteAllFiles(): void;
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
  // Removes the link row only; user-owned files remain intact.
  unlinkTelegram(): { removed: string | null };

  // Record an update id; true if newly seen, false if already processed.
  markProcessed(updateId: string): boolean;

  // True exactly once per user, on the first call. Persisted, so a relink, a
  // DO eviction or a second /start never re-introduces Zero. The
  // read-decide-write rule lives here so no caller can get the idempotency
  // wrong.
  claimFirstContact(): boolean;
}

export type Store = TopicStore &
  ConversationStore &
  LearningStore &
  ExternalCallStore &
  FileRecordStore &
  SettingsStore;
