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
export { listView, LOADING_TEXT_DELAY_MS, type ListView } from "./collection/view";

// The error-to-message helper shared by every list screen.
export { messageOf } from "./errors";

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
  dayLabel,
  localToday as capturesLocalToday,
  parseLocalDay,
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
export { homeTasks } from "./tasks/home";

// The AI icon-suggestion hint (shared shape + pure staleness check; the cache
// and fetch live per surface).
export {
  isBasisStale,
  type IconSuggestionBasis,
  type IconSuggestionStatus,
  type CachedIconSuggestions,
} from "./projects/icon-suggestions";

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
export {
  projectDisplayStatus,
  conditionSatisfied,
  unresolvedConditions,
  waitingSince,
} from "./projects/derive";
export { waitingLabel } from "./projects/waiting-label";
export {
  homeCallToAction,
  homeCallToActionCopy,
  type HomeCallToAction,
  type HomeCallToActionCopy,
} from "./projects/call-to-action";

// The WaitingCondition data layer (why a project is waiting).
export type { WaitingCondition, WaitingConditionKind } from "./waits/types";
export {
  WAITS_QUERY_KEY,
  createWaitsApi,
  createInMemoryWaitsApi,
  createPersistedWaitsApi,
  type WaitsApi,
  type WaitsRest,
  type WaitingConditionFields,
} from "./waits/collection";
export {
  ALL_STATUSES,
  BACKLOG_COLLAPSE_THRESHOLD,
  DEFAULT_ICON,
  STATUS_LABELS,
} from "./projects/display";

// The add-mode registry: what the quick-add box can create, shared web + mobile.
export {
  ADD_MODE_LABEL,
  ADD_MODE_PLACEHOLDER,
  ALL_ADD_MODES,
  addModeA11yLabel,
  type AddMode,
} from "./quick-add/modes";

// The headless toast primitive (shared controller; per-surface <Toaster> adapters).
export {
  createToastController,
  defaultToastController,
  toast,
  type Toast,
  type ToastAction,
  type ToastController,
  type ToastControllerOptions,
  type ToastInput,
} from "./toast/controller";
export { undoableAction } from "./toast/undoable";

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
