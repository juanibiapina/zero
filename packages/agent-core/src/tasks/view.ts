// What the Today list region should show, decided once and shared by the web and
// mobile screens so the local-first rule lives in one tested place. Same rule as
// inboxView (never hide existing rows behind a spinner); kept as its own helper
// so the two entities stay independent (extract a shared base at the ~3rd
// entity, per docs/todo-app.md).
export type TodayView = "rows" | "loading" | "empty" | "error";

export function todayView(state: {
  count: number;
  isLoading: boolean;
  loadError: string | null;
}): TodayView {
  if (state.count > 0) return "rows";
  if (state.isLoading) return "loading";
  if (state.loadError) return "error";
  return "empty";
}
