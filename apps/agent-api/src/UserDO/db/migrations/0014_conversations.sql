CREATE TABLE "conversations" (
  "id" TEXT PRIMARY KEY,
  "chatId" INTEGER NOT NULL,
  "topicId" INTEGER NOT NULL,
  "createdAt" TEXT NOT NULL,
  "busySince" TEXT DEFAULT NULL,
  UNIQUE ("chatId", "topicId")
);
