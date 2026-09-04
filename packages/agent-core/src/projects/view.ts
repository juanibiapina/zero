// What the Projects list region should show, decided once and shared by the web
// and mobile screens so the local-first rule lives in one tested place. Same rule
// as todayView / capturesView (never hide existing rows behind a spinner); kept
// as its own helper so the entities stay independent (extract a shared base at
// the Rule-of-Three follow-up, per docs/todo-app.md).
export type ProjectsView = "rows" | "loading" | "empty" | "error";

export function projectsView(state: {
  count: number;
  isLoading: boolean;
  loadError: string | null;
}): ProjectsView {
  if (state.count > 0) return "rows";
  if (state.isLoading) return "loading";
  if (state.loadError) return "error";
  return "empty";
}
