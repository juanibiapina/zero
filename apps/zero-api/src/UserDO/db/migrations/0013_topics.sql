CREATE TABLE "topics" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL UNIQUE,
  "description" TEXT NOT NULL DEFAULT '',
  "summary" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL DEFAULT '',
  "createdAt" TEXT NOT NULL,
  "lastActiveAt" TEXT NOT NULL,
  "messageCount" INTEGER NOT NULL DEFAULT 0
);
