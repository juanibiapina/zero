// @zero/agent-core — shared, platform-agnostic app code.
// The Capture data layer (TanStack DB collection factory) shared by web + mobile.
export type { Capture } from "./captures/types";
export {
  CAPTURES_QUERY_KEY,
  createCapturesApi,
  createInMemoryApi,
  createPersistedApi,
  type CapturesApi,
  type CapturesRest,
  type StartOfflineExecutor,
  type WarnFn,
} from "./captures/collection";
export { inboxView, type InboxView } from "./captures/view";

// The Task data layer (Today list), a sibling of the Capture layer.
export type { Task } from "./tasks/types";
export {
  TASKS_QUERY_KEY,
  createTasksApi,
  createInMemoryTasksApi,
  createPersistedTasksApi,
  tasksReconcileWrites,
  type TasksApi,
  type TasksRest,
  type TaskWrite,
} from "./tasks/collection";
export { todayView, type TodayView } from "./tasks/view";
export { dueToday, localToday } from "./tasks/today";
