import { validateRecurrence } from "@zeroapps/recurrence";
import type { MergeableStore } from "tinybase";
import { z } from "zod";

import { MedicineModel } from "../medicines/model";
import { projectDisplayStatus } from "../projects/derive";
import { TodoModel, type TodoModelResult } from "../taskdo/model";
import type { Project, Task, TaskParent } from "../taskdo/types";

export type OperationKind = "read" | "write" | "destructive";

export type OperationContext = {
  store: MergeableStore;
  now: () => Date;
  today: string;
  newId: () => string;
};

export type OperationOutcome =
  | { ok: true; changed: boolean; value: unknown }
  | { ok: false; error: string };

export type TodoOperation<Input extends z.ZodObject = z.ZodObject> = {
  name: string;
  title: string;
  description: string;
  kind: OperationKind;
  input: Input;
  run(ctx: OperationContext, input: z.infer<Input>): OperationOutcome;
};

const PlainDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const Id = z.string().min(1);
const Weekday = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
const Ordinal = z.union([z.number().int(), z.literal("last")]);
const MonthSelector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("day"), day: z.union([z.number().int().min(1).max(31), z.literal("last")]) }),
  z.object({ kind: z.literal("weekday"), ordinal: Ordinal, weekday: Weekday }),
  z.object({ kind: z.literal("workday"), ordinal: Ordinal }),
]);
const Month = z.number().int().min(1).max(12);
const YearSelector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), month: Month, day: z.number().int().min(1).max(31) }),
  z.object({ kind: z.literal("weekday"), month: Month, ordinal: Ordinal, weekday: Weekday }),
  z.object({ kind: z.literal("workday"), month: Month, ordinal: Ordinal }),
]);
const Interval = z.number().int().min(1);
const RecurrenceInput = z.object({
  version: z.literal(1),
  origin: PlainDate.describe("First scheduled date of the series"),
  anchor: z.enum(["scheduled", "completed"])
    .describe("scheduled: next date follows the schedule; completed: next date counts from the completion day"),
  weekStartsOn: z.enum(["MO", "SU"]),
  until: PlainDate.optional().describe("Inclusive last date of the series"),
  pattern: z.discriminatedUnion("unit", [
    z.object({ unit: z.literal("day"), interval: Interval }),
    z.object({ unit: z.literal("workday"), interval: Interval }),
    z.object({ unit: z.literal("week"), interval: Interval, weekdays: z.array(Weekday).min(1) }),
    z.object({ unit: z.literal("month"), interval: Interval, on: z.array(MonthSelector).min(1) }),
    z.object({ unit: z.literal("year"), interval: Interval, on: z.array(YearSelector).min(1) }),
  ]),
}).refine((value) => validateRecurrence(value).ok, "invalid recurrence");
const ProjectParent = z.object({ kind: z.literal("project"), projectId: Id });
const ParentInput = z.discriminatedUnion("kind", [ProjectParent])
  .describe("A Task's parent. Agents can set only a Project parent.");
const ParentFilter = z.discriminatedUnion("kind", [
  ProjectParent,
  z.object({ kind: z.literal("medicine"), medicineId: Id }),
]);

function define<Input extends z.ZodObject>(operation: TodoOperation<Input>): TodoOperation {
  return operation;
}

function fromModel<T>(result: TodoModelResult<T, string>): OperationOutcome {
  return result.ok
    ? { ok: true, changed: result.changed, value: result.value }
    : { ok: false, error: result.conflict };
}

function hasParent(task: Task, filter: z.infer<typeof ParentFilter>): boolean {
  const parent: TaskParent | null = task.parent;
  if (parent?.kind !== filter.kind) return false;
  return parent.kind === "project"
    ? filter.kind === "project" && parent.projectId === filter.projectId
    : filter.kind === "medicine" && parent.medicineId === filter.medicineId;
}

const read = (value: unknown): OperationOutcome => ({ ok: true, changed: false, value });
const todo = (ctx: OperationContext) => new TodoModel({ store: ctx.store, now: ctx.now });
const medicines = (ctx: OperationContext) => new MedicineModel(ctx.store, ctx.now);

function withAttention(projects: Project[], model: TodoModel, today: string) {
  const projection = model.project();
  return projects.map((project) => ({
    ...project,
    attention: projectDisplayStatus(project, projection.tasks, today, projection.conditions, projection.projects),
  }));
}

export const todoOperations: readonly TodoOperation[] = [
  define({
    name: "tasks_list",
    title: "List open Tasks",
    description:
      "List open Tasks in the user's manual order. A Task is the only to-do item; it is loose or belongs to a Project. " +
      "showUpDate is the day it becomes current (null means always current); Home shows open Tasks whose showUpDate is " +
      "null or on/before today, Upcoming shows later ones. Recurring Tasks carry recurrence and recurrenceDate (the current occurrence). " +
      "parent is null for a loose Task, { kind: project, projectId } for a Project Task, or { kind: medicine, medicineId, role } " +
      "for a Medicine Task; role restock means Zero added it because the supply ran low. " +
      "Completing it here does not add pills; the user records the amount in the app.",
    kind: "read",
    input: z.object({ parent: ParentFilter.optional().describe("Only Tasks with this parent") }),
    run: (ctx, input) => {
      const tasks = todo(ctx).project({ taskOrder: "manual" }).tasks;
      const { parent } = input;
      return read({ today: ctx.today, tasks: parent ? tasks.filter((task) => hasParent(task, parent)) : tasks });
    },
  }),
  define({
    name: "tasks_create",
    title: "Create a Task",
    description:
      "Create a Task. Omit id to have one generated; pass your own UUID to make retries safe. " +
      "With a recurrence, the Task first shows up on recurrence.origin.",
    kind: "write",
    input: z.object({
      id: Id.optional(),
      text: z.string().trim().min(1),
      showUpDate: PlainDate.nullable().optional().describe("Day the Task becomes current; omit for always current"),
      parent: ParentInput.nullable().optional(),
      recurrence: RecurrenceInput.nullable().optional(),
    }),
    run: (ctx, input) => fromModel(todo(ctx).createTask({
      id: input.id ?? ctx.newId(),
      text: input.text,
      showUpDate: input.showUpDate ?? null,
      parent: input.parent ?? null,
      recurrence: (input.recurrence) ?? null,
    })),
  }),
  define({
    name: "tasks_update",
    title: "Update a Task",
    description: "Change a Task's text, showUpDate, or parent Project. Pass null to clear showUpDate or to make the Task loose.",
    kind: "write",
    input: z.object({
      id: Id,
      text: z.string().trim().min(1).optional(),
      showUpDate: PlainDate.nullable().optional(),
      parent: ParentInput.nullable().optional(),
    }),
    run: (ctx, { id, ...fields }) => {
      if (Object.values(fields).every((value) => value === undefined)) return { ok: false, error: "nothing to update" };
      return fromModel(todo(ctx).patchTask(id, fields));
    },
  }),
  define({
    name: "tasks_complete",
    title: "Complete a Task",
    description:
      "Complete a Task. A recurring Task advances to its next occurrence instead, and is completed only when its series ends. " +
      "completedOn defaults to the user's today.",
    kind: "write",
    input: z.object({ id: Id, completedOn: PlainDate.optional() }),
    run: (ctx, input) => {
      const model = todo(ctx);
      const task = model.getTask(input.id);
      if (task?.recurrence && task.recurrenceDate && !task.completedAt) {
        return fromModel(model.completeOccurrence(input.id, task.recurrenceDate, input.completedOn ?? ctx.today));
      }
      return fromModel(model.completeTask(input.id));
    },
  }),
  define({
    name: "tasks_reopen",
    title: "Reopen a Task",
    description: "Reopen a completed Task.",
    kind: "write",
    input: z.object({ id: Id }),
    run: (ctx, input) => fromModel(todo(ctx).reopenTask(input.id)),
  }),
  define({
    name: "tasks_set_recurrence",
    title: "Set a Task's recurrence",
    description:
      "Make a Task recurring, change its schedule, or pass null to make it a one-off. " +
      "Setting a recurrence moves the Task's showUpDate to recurrence.origin.",
    kind: "write",
    input: z.object({ id: Id, recurrence: RecurrenceInput.nullable() }),
    run: (ctx, input) => fromModel(todo(ctx).setTaskRecurrence(input.id, input.recurrence)),
  }),
  define({
    name: "projects_list",
    title: "List Projects",
    description:
      "List Projects. A Project is an outcome holding Tasks, Waiting conditions, and Afters. state is the user's lifecycle choice " +
      "(in-play, backlog, done). attention is calculated: active (has current Tasks), next (ready for a next Task), waiting " +
      "(unresolved Waiting condition or only future-dated Tasks), after (waiting for another Project to finish), backlog, done.",
    kind: "read",
    input: z.object({ includeDone: z.boolean().optional().describe("Also list done Projects") }),
    run: (ctx, input) => {
      const model = todo(ctx);
      const all = model.project().projects;
      const projects = input.includeDone ? all : all.filter((project) => project.state !== "done");
      return read({ today: ctx.today, projects: withAttention(projects, model, ctx.today) });
    },
  }),
  define({
    name: "projects_create",
    title: "Create a Project",
    description: "Create a Project. icon is one emoji (defaults to 📁). state defaults to in-play.",
    kind: "write",
    input: z.object({
      id: Id.optional(),
      title: z.string().trim().min(1),
      icon: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      state: z.enum(["in-play", "backlog", "done"]).optional(),
    }),
    run: (ctx, { id, ...fields }) => fromModel(todo(ctx).createProject({ id: id ?? ctx.newId(), ...fields })),
  }),
  define({
    name: "projects_edit",
    title: "Edit a Project",
    description: "Change a Project's title, icon, or description. Pass description null to clear it.",
    kind: "write",
    input: z.object({
      id: Id,
      title: z.string().trim().min(1).optional(),
      icon: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
    }),
    run: (ctx, { id, ...fields }) => {
      if (Object.keys(fields).length === 0) return { ok: false, error: "nothing to update" };
      return fromModel(todo(ctx).editProject(id, fields));
    },
  }),
  define({
    name: "projects_set_state",
    title: "Set a Project's lifecycle state",
    description:
      "Move a Project to in-play, backlog, or done. Marking it done settles Afters that wait for it; reopening restores them.",
    kind: "write",
    input: z.object({ id: Id, state: z.enum(["in-play", "backlog", "done"]) }),
    run: (ctx, input) => fromModel(todo(ctx).setProjectState(input.id, input.state)),
  }),
  define({
    name: "projects_delete",
    title: "Delete a Project",
    description:
      "Delete a Project permanently, together with all its Tasks, its Waiting conditions, and every After that references it. " +
      "Returns how many of each were removed. Prefer projects_set_state done for finished work.",
    kind: "destructive",
    input: z.object({ id: Id }),
    run: (ctx, input) => fromModel(todo(ctx).deleteProject(input.id)),
  }),
  define({
    name: "conditions_list",
    title: "List Waiting conditions and Afters",
    description:
      "List open Project conditions. kind free-text is a Waiting condition: prose the user reviews and resolves by hand. " +
      "kind project-status is an After: the Project waits until the Project in refId is done.",
    kind: "read",
    input: z.object({ projectId: Id.optional() }),
    run: (ctx, input) => {
      const conditions = todo(ctx).project().conditions;
      return read({ conditions: input.projectId ? conditions.filter((c) => c.projectId === input.projectId) : conditions });
    },
  }),
  define({
    name: "waiting_create",
    title: "Add a Waiting condition",
    description: "Add a Waiting condition to a Project: what the Project is waiting for, in prose.",
    kind: "write",
    input: z.object({ id: Id.optional(), projectId: Id, text: z.string().trim().min(1) }),
    run: (ctx, input) => fromModel(todo(ctx).createWaiting(input.id ?? ctx.newId(), input.projectId, input.text)),
  }),
  define({
    name: "waiting_resolve",
    title: "Resolve a Waiting condition",
    description: "Mark a Waiting condition resolved.",
    kind: "write",
    input: z.object({ id: Id }),
    run: (ctx, input) => fromModel(todo(ctx).resolveWaiting(input.id)),
  }),
  define({
    name: "after_create",
    title: "Sequence a Project after another",
    description:
      "Make projectId wait until afterProjectId is done. Fails with self, duplicate, cycle, missing-source, missing-target, or target-done.",
    kind: "write",
    input: z.object({ id: Id.optional(), projectId: Id, afterProjectId: Id }),
    run: (ctx, input) => fromModel(todo(ctx).createAfter(input.id ?? ctx.newId(), input.projectId, input.afterProjectId)),
  }),
  define({
    name: "conditions_delete",
    title: "Delete a Waiting condition or After",
    description: "Delete a Waiting condition or After by id.",
    kind: "destructive",
    input: z.object({ id: Id }),
    run: (ctx, input) => fromModel(todo(ctx).deleteCondition(input.id)),
  }),
  define({
    name: "medicines_list",
    title: "List Medicines and recent Doses",
    description:
      "List Medicines (routines with timed doses on chosen weekdays, ISO 1 = Monday) and their Doses since a date. A Dose is one dated occurrence; " +
      "takenAt is null until the user confirms it on their phone. Each dose time takes amount pills. supply is null until the user counts their pills; " +
      "otherwise pillsLeft, leadDays (Zero adds a restock Task when the pills left cover only this many days), and refill (the last restock amount).",
    kind: "read",
    input: z.object({ dosesSince: PlainDate.optional().describe("Earliest Dose date; defaults to 7 days ago") }),
    run: (ctx, input) => {
      const since = input.dosesSince ?? shiftDay(ctx.today, -7);
      const snapshot = medicines(ctx).snapshot();
      return read({
        today: ctx.today,
        medicines: snapshot.medicines,
        doses: snapshot.doses.filter((dose) => dose.on >= since),
      });
    },
  }),
  define({
    name: "recoveries_list",
    title: "List rows that need repair",
    description:
      "List synchronized rows the app cannot accept as-is (invalid data, missing or deleted parents, cycles). " +
      "They are hidden from the other lists; the user repairs them from Home.",
    kind: "read",
    input: z.object({}),
    run: (ctx) => read({
      todo: todo(ctx).project().issues,
      medicines: medicines(ctx).snapshot().recoveries,
    }),
  }),
];

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const byName = new Map(todoOperations.map((operation) => [operation.name, operation]));

export function findTodoOperation(name: string): TodoOperation | undefined {
  return byName.get(name);
}

export function runTodoOperation(ctx: OperationContext, name: string, input: unknown): OperationOutcome {
  const operation = byName.get(name);
  if (!operation) return { ok: false, error: `unknown operation: ${name}` };
  const parsed = operation.input.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return operation.run(ctx, parsed.data);
}

export type { Task, Project };
