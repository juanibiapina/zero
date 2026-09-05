-- Provenance for the Capture -> Task/Project transition (Refine): the capture a
-- task or project was created from during a refine session, or NULL. Nullable;
-- ADD COLUMN cannot be NOT NULL on a populated table. See
-- docs/plans/todo-availability-model.md (slice 8).
ALTER TABLE "tasks" ADD COLUMN "sourceCaptureId" TEXT;
ALTER TABLE "projects" ADD COLUMN "sourceCaptureId" TEXT;
