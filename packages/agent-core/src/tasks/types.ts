// A Task: one typed, clarified next-action with a day, the Today list's item.
// Distinct from a Capture (the untyped Captures entry): a Task is completed (done),
// a Capture is processed (clarified out). The single shared entity type for the
// Task data layer, used by web and mobile.
export type Task = {
  id: string;
  text: string;
  // Local day (YYYY-MM-DD) the task should show up on, or null for a loose,
  // always-relevant task (a quick capture with no day). Minted by the client in
  // the user's timezone. The shown-up split (showUpDate == null || <= today)
  // runs client-side, so the server never needs a timezone. A future day parks
  // the task in Upcoming.
  showUpDate: string | null;
  createdAt: string;
  completedAt: string | null;
  // The Project this task belongs to, or null when the task is loose.
  projectId: string | null;
  // When the user took this task on (curated it onto Home), or null when parked.
  // Only gates project tasks; loose tasks always show on Home.
  takenOnAt: string | null;
  // The capture this task was refined from, or null. Dormant after the merge.
  // Optional so optimistic drafts need not carry it.
  sourceCaptureId?: string | null;
  // Fractional-index sort key for the manual list order, or null (unkeyed, sorts
  // last — newest-at-bottom). Keyed in practice (server mints the trailing key on
  // add, reorder sets it, an init backfill keys legacy rows); null is a transient
  // state — the optimistic just-added row before the server assigns its key on
  // reconcile. Ordering tolerates null on both sides.
  sortKey: string | null;
};
