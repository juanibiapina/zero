CREATE TABLE "knowledge" (
  "id" INTEGER PRIMARY KEY,
  "version" INTEGER NOT NULL DEFAULT 1,
  "systemFingerprint" TEXT DEFAULT NULL
);
--> statement-breakpoint
INSERT INTO "knowledge" ("id", "version") VALUES (1, 1);
