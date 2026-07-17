import { table, column } from "do-orm";

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
  id: column.integer().primaryKey().autoIncrement(),
  name: column.text().notNull().unique(),
  description: column.text().notNull().default(""),
  summary: column.text().notNull().default(""),
  body: column.text().notNull().default(""),
  createdAt: column.text().notNull(),
  lastActiveAt: column.text().notNull(),
  messageCount: column.integer().notNull().default(0),
});

// Conversations: one thread per Telegram (chatId, topicId). `busySince` marks a
// thread mid-turn for the typing loop / stale guard.
export const conversations = table("conversations", {
  id: column.text().notNull().primaryKey(),
  chatId: column.integer().notNull(),
  topicId: column.integer().notNull(),
  createdAt: column.text().notNull(),
  busySince: column.text(),
});

// Messages: explicit user/assistant exchanges within a conversation.
export const messages = table("messages", {
  id: column.integer().primaryKey().autoIncrement(),
  conversationId: column.text().notNull(),
  role: column.text().notNull(),
  content: column.text().notNull(),
  createdAt: column.text().notNull(),
});

// Webhook idempotency: dedupe fully re-delivered Telegram updates.
export const processedUpdates = table("processed_updates", {
  updateId: column.text().notNull().primaryKey(),
  createdAt: column.text().notNull(),
});
