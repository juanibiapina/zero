CREATE TABLE "topic_links" (
  "sourceId" INTEGER NOT NULL REFERENCES "topics"("id") ON DELETE CASCADE,
  "targetName" TEXT NOT NULL,
  "targetId" INTEGER REFERENCES "topics"("id") ON DELETE SET NULL,
  PRIMARY KEY ("sourceId", "targetName")
);
--> statement-breakpoint
CREATE INDEX "topic_links_target_name" ON "topic_links" ("targetName");
--> statement-breakpoint
CREATE INDEX "topic_links_target_id" ON "topic_links" ("targetId");
