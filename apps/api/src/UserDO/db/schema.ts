import { table, column } from "do-orm";

export const telegramLink = table("telegram_link", {
  id: column.integer().primaryKey().autoIncrement(),
  telegramId: column.text().notNull().unique(),
});

export const sessions = table("sessions", {
  id: column.integer().primaryKey().autoIncrement(),
  type: column.text().notNull(),
  chatId: column.integer().notNull(),
  topicId: column.integer().notNull(),
  sessionId: column.text().notNull().unique(),
});

export const mountConfigs = table("mount_configs", {
  id: column.integer().primaryKey().autoIncrement(),
  scope: column.text().notNull().unique(),
  endpoint: column.text().notNull(),
  bucket: column.text().notNull(),
  prefix: column.text().notNull(),
  accessKeyId: column.text().notNull(),
  secretAccessKey: column.text().notNull(),
});

export const userSettings = table("user_settings", {
  id: column.integer().primaryKey().autoIncrement(),
  onboardingSeen: column.integer().notNull(),
});
