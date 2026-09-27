# Capture (retired)

**Capture no longer exists.** The Capture/Task split proved premature, so the
**single-list merge** collapsed Capture
into **Task**: Task is now the single entity and the app's entry point, and a
quick-add with no project creates a loose task. There is no `captures` table,
route, store, collection, `Capture` type, or Process/Refine step anymore.

Everything Capture owned — the raw entry point, the nullable show-up date, the
manual drag-reorder, and the Captures/Upcoming visibility split — now lives on
Task. See **`docs/entities/task.md`** (source of truth) and the merge plan.

Historical note: Capture data was disposable and dropped by migration 0051; task
data was preserved. Existing `sourceCaptureId` cells remain as inert legacy
storage and REST compatibility data; the current Task and Project interfaces do
not expose them.
