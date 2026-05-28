CREATE TABLE "mount_configs" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "scope" TEXT NOT NULL UNIQUE,
  "endpoint" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "accessKeyId" TEXT NOT NULL,
  "secretAccessKey" TEXT NOT NULL
);
