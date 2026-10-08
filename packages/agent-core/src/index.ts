// @zero/agent-core — shared, platform-agnostic app code.

export { MedicineModel, medicineToday, medicineEndDate, medicineOccurrences, medicineState, medicineDueOn, medicineNextDay, medicineCadence, medicineRecurrence, doseId, validateMedicine, type Weekday, type Medicine, type MedicineInput, type MedicineSlot, type MedicineSupply, type MedicineRestock, type Dose, type MedicineReceipt, type MedicineSnapshot } from "./medicines/model";
export { MedicineDraft, type MedicineCourse } from "./medicines/draft";
export { DEFAULT_LEAD_DAYS, daysLeft, restockThreshold, supplyIsLow, supplyLabel } from "./medicines/supply";
export { pillCount, restockWithUndo } from "./medicines/restock-action";
export type { TodoMedicines } from "./taskdo/replica";
export { createMedicineReminders, type MedicineReminders } from "./medicines/reminders";
export { MEDICINE_CHANNEL, MEDICINE_SOURCE, medicineOccurrence, medicineReceipt, medicineReminderKey, medicineSchedule } from "./medicines/notifications";

// Scheduled device notifications: the schedule format shared with the native module.
export {
  parseSchedule,
  type Action as NotificationAction,
  type Channel as NotificationChannel,
  type LocalDate,
  type LocalTime,
  type NotificationCapabilities,
  type NotificationDevice,
  type Receipt as NotificationReceipt,
  type Recurrence,
  type Reminder as NotificationReminder,
  type Schedule as NotificationSchedule,
  type ScheduleError,
  type ScheduleResult,
  type Stage as NotificationStage,
} from "./notifications/schedule";
export { nextOccurrence, occursOn } from "./notifications/recurrence";
export { createInMemoryNotificationDevice, type InMemoryNotificationDevice } from "./notifications/in-memory-device";

// Shared list-region behavior.
export { listView, LOADING_TEXT_DELAY_MS, type ListView } from "./collection/view";

// The error-to-message helper shared by every list screen.
export { messageOf } from "./errors";

// The Task data layer (the single list) shared by web + mobile.
export type { Task, TaskParent } from "./taskdo/types";
export { projectParent, taskCompletion, taskMedicineId, taskProjectId, type TaskCompletion } from "./tasks/parent";
export { localToday } from "./tasks/today";
export { TaskDraft, type TaskDraftView, type TaskDraftCommit } from "./tasks/draft";
export {
  ProjectSuggester,
  projectSuggestionCandidates,
  type ProjectSelection,
  type ProjectSelectionSource,
  type ProjectSuggestionCandidate,
  type ProjectSuggestionRequest,
  type ProjectSuggestionState,
} from "./tasks/project-suggestion";
export { homeTasks } from "./tasks/home";
export {
  dayLabel,
  monthMatrix,
  parseLocalDay,
  scheduleLabel,
  tomorrow,
  weekdayShort,
} from "./tasks/dates";
export { upcomingSections, type UpcomingSection } from "./tasks/upcoming";
export { compareByOrder, orderKeyBetween } from "./tasks/order";

// The AI icon-suggestion hint (shared shape + pure staleness check; the cache
// and fetch live per surface).
export {
  isBasisStale,
  type IconSuggestionBasis,
  type IconSuggestionStatus,
  type CachedIconSuggestions,
} from "./projects/icon-suggestions";
export {
  IconSuggester,
  type IconChoice,
  type IconChoiceSource,
  type IconSuggestionRequest,
} from "./projects/icon-suggester";

// The Project data layer (Projects list).
export type {
  Project,
  ProjectState,
  ProjectDisplayStatus,
} from "./projects/types";
export {
  projectStatusSections,
  type ProjectSection,
} from "./projects/sections";
export {
  projectDisplayStatus,
  unresolvedConditions,
  waitingSince,
  waitingUntil,
} from "./projects/derive";
export {
  isManualWaitingCondition,
  isProjectAfter,
  projectAfters,
  projectAfterContext,
  projectAfterRemovalImpact,
  projectAfterRemovalWarning,
  projectsAfterTarget,
  unresolvedProjectAfters,
  wouldCreateAfterCycle,
  type ProjectAfterContext,
  type ProjectAfterRelationship,
  type ProjectAfterRemovalImpact,
} from "./projects/afters";
export {
  projectStatusContext,
  type ProjectStatusContext,
} from "./projects/status-context";
export { waitingLabel } from "./projects/waiting-label";
export { waitingBadge, type WaitingBadge } from "./projects/waiting-badge";
export {
  homeCallToAction,
  homeCallToActionCopy,
  type HomeCallToAction,
  type HomeCallToActionCopy,
} from "./projects/call-to-action";

// Manual Waiting and Project After share persistence, not product semantics.
export type {
  ManualWaitingCondition,
  ProjectAfter,
  ProjectAttention,
  WaitingCondition,
} from "./taskdo/types";
export {
  ALL_PROJECT_DISPLAY_STATUSES,
  BACKLOG_COLLAPSE_THRESHOLD,
  DEFAULT_ICON,
  MEDICINE_TASK_ICON,
  PROJECT_DISPLAY_STATUS_LABELS,
  taskIcon,
} from "./projects/display";
// The TaskDO local replica shared by the web and mobile platform adapters.
export {
  createTaskdoReplica,
  projectTodoData,
  repairTodoRecovery,
  type CreateTaskdoReplicaOptions,
  type ProjectEditFields,
  type TaskdoReplica,
  type TodoProjects,
  type TodoRecovery,
  type TodoRecoveryRepair,
  type TodoSnapshot,
  type TodoTasks,
  type TodoWaits,
} from "./taskdo/replica";
export { keepTaskParentsMigrated } from "./taskdo/task-parent-cell";
export {
  TASK_SYNC_SCHEMA,
  taskSyncPath,
  createTaskdoSyncLifecycle,
  type CreateTaskdoSyncLifecycleOptions,
  type TaskdoSyncLifecycle,
  type TaskdoSyncPhase,
  type TaskdoSyncState,
  type TaskdoSynchronizer,
} from "./taskdo/sync";
export {
  createSyncedTaskdoReplicaSession,
  type CreateSyncedTaskdoReplicaSessionOptions,
  type SyncedTaskdoReplicaSession,
} from "./taskdo/replica-session";
export {
  todoSyncPresentation,
  type TodoSyncDisplayKind,
  type TodoSyncPresentation,
} from "./taskdo/sync-presentation";
export {
  createAccountTaskdoReplicaOwner,
  selectAccountTaskdoReplicaState,
  type AccountTaskdoReplicaEvents,
  type AccountTaskdoReplicaOwner,
  type AccountTaskdoReplicaState,
  type CreateAccountTaskdoReplicaOwnerOptions,
  type OpenAccountTaskdoReplica,
  type OpenedAccountTaskdoReplica,
  type TaskdoReplicaClientState,
  type TodoReplicaDurability,
} from "./taskdo/account-replica-owner";
export {
  createInMemoryTaskdoClientState,
  createInMemoryTaskdoReplica,
  type InMemoryTodoSeed,
} from "./taskdo/in-memory";
export {
  TodoModel,
  type ProjectDefaults,
  type ProjectInput,
  type TaskInput,
  type TodoModelResult,
  type TodoProjection,
} from "./taskdo/model";
export type {
  ProjectAfterConflict,
  TodoIssue,
} from "./taskdo/types";

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
  type ToastDescriptionAction,
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

export { taskRecurrenceLabel, taskCompletionMessage } from "./tasks/recurrence-display";
