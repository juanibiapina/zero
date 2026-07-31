CREATE TABLE "files" (
  "id" text PRIMARY KEY NOT NULL,
  "storageKey" text NOT NULL,
  "filename" text NOT NULL,
  "mimeType" text NOT NULL,
  "byteSize" integer,
  "createdAt" text NOT NULL
);

INSERT INTO "files" ("id", "storageKey", "filename", "mimeType", "byteSize", "createdAt")
SELECT "id", "r2Key", "filename", "mimeType", NULL, "createdAt"
FROM "attachments";

DROP TABLE "attachments";
