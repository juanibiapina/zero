import { table, column } from "do-orm";

export const telegramLink = table("telegram_link", {
  id: column.integer().primaryKey().autoIncrement(),
  telegramId: column.text().notNull().unique(),
});

export const sessions = table("sessions", {
  id: column.integer().primaryKey().autoIncrement(),
  chatId: column.integer().notNull(),
  topicId: column.integer().notNull(),
  sessionId: column.text().notNull().unique(),
});
