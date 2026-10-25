import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrations } from "./migrations";

const apply = (db: DatabaseSync, sql: string) => {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
};

const migratedThrough = (last: string): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const [key, sql] of Object.entries(migrations)) {
    apply(db, sql);
    if (key === last) break;
  }
  return db;
};

const tables = (db: DatabaseSync) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name")
    .all()
    .map((row) => row.name);

describe("0058 agent data migration", () => {
  it("drops every agent table and keeps each user's timezone and creation date", () => {
    const db = migratedThrough("m0057");
    db.exec(`
      INSERT INTO user_settings (onboardingSeen, createdAt, timezone, country) VALUES (1, '2026-01-02T03:04:05.000Z', 'Europe/Berlin', 'DE');
      INSERT INTO telegram_link (telegramId) VALUES ('42');
      INSERT INTO topics (name, createdAt, lastActiveAt) VALUES ('User', 'x', 'x'), ('Other', 'x', 'x');
      INSERT INTO topic_links (sourceId, targetName, targetId) VALUES (1, 'Other', 2);
      INSERT INTO conversations (id, chatId, topicId, createdAt) VALUES ('c1', 1, 0, 'x');
    `);
    db.exec(`INSERT INTO messages (conversationId, role, content, createdAt) VALUES ('c1', 'user', 'hi', 'x')`);
    db.exec(`INSERT INTO deliveries (messageId, blockIndex, claimedAt) VALUES (1, 0, 'x')`);
    db.exec(`INSERT INTO schedules (id, conversationId, prompt, pattern, timezone, nextDueAt, createdAt) VALUES ('s1', 'c1', 'p', 'once', 'UTC', 1, 'x')`);
    db.exec(`INSERT INTO mail_threads (threadId, conversationId, createdAt) VALUES ('t1', 'c1', 'x')`);

    apply(db, migrations.m0058);

    expect(tables(db)).toEqual(["user_settings"]);
    expect(db.prepare("SELECT * FROM user_settings").all()).toEqual([
      { id: 1, createdAt: "2026-01-02T03:04:05.000Z", timezone: "Europe/Berlin" },
    ]);
  });
});
