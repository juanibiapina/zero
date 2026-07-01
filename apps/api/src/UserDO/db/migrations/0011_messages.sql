CREATE TABLE "messages" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "sessionId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_messages_session" ON "messages" ("sessionId", "id");
