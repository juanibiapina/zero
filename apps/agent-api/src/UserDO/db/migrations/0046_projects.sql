-- Projects: the third entity of the todo app (after Capture and Task). A Project
-- is a named, outcome-oriented container with a status; distinct from a Capture
-- (untyped) and a Task (a dated next-action). Standalone from the agent's
-- tables; owned by DbProjectStore. `id` is a client-minted UUID; `status` is one
-- of active/next/waiting/backlog/done and defaults to 'next' on create. See
-- docs/entities/project.md.
CREATE TABLE "projects" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  -- A single emoji, defaulted at creation and enriched later. Kept a plain
  -- string so the icon representation can evolve (SF Symbols, custom art)
  -- without a data migration.
  "icon" TEXT NOT NULL,
  -- Free-text notes (a sentence of intent). Nullable; empty by default.
  "description" TEXT,
  -- One of active/next/waiting/backlog/done. 'done' is terminal.
  "status" TEXT NOT NULL DEFAULT 'next',
  "createdAt" TEXT NOT NULL
);

-- Partial index for the working-list query (WHERE status != 'done' ORDER BY
-- createdAt). Indexes only non-done rows, so it stays small as finished projects
-- accumulate. In slice A1 every row is 'next'; the scoping lands in A2.
CREATE INDEX "projects_open" ON "projects" ("createdAt") WHERE "status" != 'done';
