DROP TABLE IF EXISTS "messages";
--> statement-breakpoint
CREATE TABLE "messages" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "conversationId" TEXT NOT NULL REFERENCES "conversations"("id"),
  "role" TEXT NOT NULL CHECK ("role" IN ('user', 'assistant')),
  "content" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);
