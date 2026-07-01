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
  status: column.text().notNull(),
  name: column.text(),
  updatedAt: column.text(),
});

export const messages = table("messages", {
  id: column.integer().primaryKey().autoIncrement(),
  sessionId: column.text().notNull(),
  role: column.text().notNull(),
  text: column.text().notNull(),
  createdAt: column.text().notNull(),
});


export const userSettings = table("user_settings", {
  id: column.integer().primaryKey().autoIncrement(),
  onboardingSeen: column.integer().notNull(),
  googleOnboardingStatus: column.text(),
  createdAt: column.text(),
});
