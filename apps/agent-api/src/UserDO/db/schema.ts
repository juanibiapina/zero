import { table, column, ref } from "do-orm";

export const telegramLink = table("telegram_link", {
  id: column.integer().primaryKey().autoIncrement(),
  telegramId: column.text().notNull().unique(),
});

export const userSettings = table("user_settings", {
  id: column.integer().primaryKey().autoIncrement(),
  onboardingSeen: column.integer().notNull(),
  googleOnboardingStatus: column.text(),
  createdAt: column.text(),
  // Canonical IANA name (e.g. "Europe/Berlin"), never an offset. Null until the
  // web app reports the browser's zone on first mount.
  timezone: column.text(),
});

// Topics: the durable knowledge model. `id` is a stable surrogate key so a
// rename is a one-field `name` update; `name` is what the agent addresses.
export const topics = table("topics", {
  id: column.integer().notNull().primaryKey().autoIncrement(),
  name: column.text().notNull().unique(),
  description: column.text().notNull().default(""),
  summary: column.text().notNull().default(""),
  body: column.text().notNull().default(""),
  createdAt: column.text().notNull(),
  lastActiveAt: column.text().notNull(),
  messageCount: column.integer().notNull().default(0),
  // Pinned topics are always rendered into the interface agent's prompt (see
  // docs/topics.md). Ordinary topics otherwise; pinning is set via the Store.
  pinned: column.integer().notNull().default(0),
});

// Topic links: the `[[Name]]` wiki-links found in a topic body, one row per
// (source topic, target name). `targetId` resolves to the target topic when one
// with that exact `name` exists, else null (a dangling link). Rows are
// re-derived from the body on every write, so they never drift from the text.
export const topicLinks = table("topic_links", {
  sourceId: column.integer().notNull().references(ref(topics, "id")),
  targetName: column.text().notNull(),
  targetId: column.integer().references(ref(topics, "id")),
});

// Conversations: one thread per Telegram (chatId, topicId).
export const conversations = table("conversations", {
  id: column.text().notNull().primaryKey(),
  chatId: column.integer().notNull(),
  topicId: column.integer().notNull(),
  createdAt: column.text().notNull(),
});

// Messages: explicit user/assistant exchanges within a conversation.
export const messages = table("messages", {
  id: column.integer().primaryKey().autoIncrement(),
  conversationId: column.text().notNull(),
  role: column.text().notNull(),
  content: column.text().notNull(),
  createdAt: column.text().notNull(),
});

// Attachments: lookup-by-id metadata for files the user sent. Bytes live in R2
// under `r2Key`; the id is embedded in the message marker so view_attachment
// can re-fetch a file referenced from any past turn.
export const attachments = table("attachments", {
  id: column.text().notNull().primaryKey(),
  conversationId: column.text().notNull(),
  r2Key: column.text().notNull(),
  filename: column.text().notNull(),
  mimeType: column.text().notNull(),
  createdAt: column.text().notNull(),
});

// Webhook idempotency: dedupe fully re-delivered Telegram updates.
export const processedUpdates = table("processed_updates", {
  updateId: column.text().notNull().primaryKey(),
  createdAt: column.text().notNull(),
});
