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
export { capturesView, type CapturesView } from "./captures/view";
export {
  localToday as capturesLocalToday,
  tomorrow,
  visibleCaptures,
} from "./captures/dates";
export { upcomingSections, type UpcomingSection } from "./captures/upcoming";
export { compareByOrder, orderKeyBetween } from "./captures/order";

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

// The Project data layer (Projects list), a sibling of the Task layer.
export type { Project, ProjectStatus } from "./projects/types";
export {
  PROJECTS_QUERY_KEY,
  createProjectsApi,
  createInMemoryProjectsApi,
  createPersistedProjectsApi,
  projectsReconcileWrites,
  type ProjectsApi,
  type ProjectsRest,
  type ProjectEditFields,
  type ProjectWrite,
} from "./projects/collection";
export { projectsView, type ProjectsView } from "./projects/view";
export {
  projectsByStatus,
  PROJECT_SECTION_ORDER,
  type ProjectSection,
} from "./projects/sections";

// Silent automatic timezone sync (shared core; per-surface adapters).
export {
  createTimezoneSync,
  isCanonicalZone,
  type DeviceClock,
  type SettingsGateway,
  type TimezoneStore,
  type TimezoneSync,
  type TimezoneSyncDeps,
} from "./timezone/sync";
