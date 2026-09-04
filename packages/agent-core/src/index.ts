// @zero/agent-core — shared, platform-agnostic app code.

// The shared collection plumbing every entity is built on: the offline
// collection factory's injected types and the list-region view rule.
export {
  reconcileWrites,
  type EntityApiDeps,
  type StartOfflineExecutor,
  type WarnFn,
  type Write,
} from "./collection/base";
export { listView, type ListView } from "./collection/view";

// The Capture data layer (TanStack DB collection) shared by web + mobile.
export type { Capture } from "./captures/types";
export {
  CAPTURES_QUERY_KEY,
  createCapturesApi,
  createInMemoryApi,
  createPersistedApi,
  type CapturesApi,
  type CapturesRest,
} from "./captures/collection";
export {
  localToday as capturesLocalToday,
  tomorrow,
  visibleCaptures,
} from "./captures/dates";
export { upcomingSections, type UpcomingSection } from "./captures/upcoming";
export { compareByOrder, orderKeyBetween } from "./captures/order";

// The Task data layer (Today list).
export type { Task } from "./tasks/types";
export {
  TASKS_QUERY_KEY,
  createTasksApi,
  createInMemoryTasksApi,
  createPersistedTasksApi,
  type TasksApi,
  type TasksRest,
} from "./tasks/collection";
export { dueToday, localToday } from "./tasks/today";

// The Project data layer (Projects list).
export type { Project, ProjectStatus } from "./projects/types";
export {
  PROJECTS_QUERY_KEY,
  createProjectsApi,
  createInMemoryProjectsApi,
  createPersistedProjectsApi,
  type ProjectsApi,
  type ProjectsRest,
  type ProjectEditFields,
} from "./projects/collection";
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
