// A Task: one typed, clarified next-action with a day, the Today list's item.
// Distinct from a Capture (the untyped Inbox entry): a Task is completed (done),
// a Capture is processed (clarified out). The single shared entity type for the
// Task data layer, used by web and mobile.
export type Task = {
  id: string;
  text: string;
  // Local date (YYYY-MM-DD) the task should show up on. Minted by the client in
  // the user's timezone. The "due today" filter (showUpDate <= today) runs
  // client-side, so the server never needs a timezone.
  showUpDate: string;
  createdAt: string;
  completedAt: string | null;
};
