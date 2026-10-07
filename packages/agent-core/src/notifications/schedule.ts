import { z } from "zod";

export type LocalDate = string;
export type LocalTime = string;
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type Channel = { id: string; name: string; group: { id: string; name: string } };

export type Recurrence = { from: LocalDate; until: LocalDate | null; weekdays: Weekday[] };

export type Stage = { at: LocalTime; wake: "exact" | "alarmClock"; text: string };

export type Action =
  | { id: string; label: string; kind: "settle" }
  | { id: string; label: string; kind: "snooze"; minutes: number };

export type Reminder = {
  key: string;
  channel: string;
  icon: "pill";
  title: string;
  lockScreen: { title: string; text: string };
  url: string;
  recurrence: Recurrence;
  stages: Stage[];
  actions: Action[];
  settled: LocalDate[];
  data: string;
};

export type Schedule = { channels: Channel[]; reminders: Reminder[] };

export type Receipt = {
  id: string;
  source: string;
  key: string;
  date: LocalDate;
  at: string;
  data: string;
} & ({ type: "presented" } | { type: "settled"; action: string });

export type NotificationDevice = {
  install(workspace: string, source: string, schedule: Schedule): Promise<void>;
  receipts(workspace: string, source: string): Promise<Receipt[]>;
  acknowledge(workspace: string, source: string, receiptIds: string[]): Promise<void>;
  settle(workspace: string, source: string, key: string, date: LocalDate, action: string): Promise<Receipt>;
  quiesce(workspace: string): Promise<void>;
  clear(workspace: string): Promise<void>;
};

export type NotificationCapabilities = {
  notifications: boolean;
  exactAlarms: boolean;
  backgroundRestricted: boolean;
  channels: Record<string, boolean>;
};

export type ScheduleError =
  | "invalid-shape"
  | "invalid-channel"
  | "invalid-key"
  | "invalid-date"
  | "invalid-time"
  | "invalid-recurrence"
  | "invalid-stages"
  | "invalid-actions"
  | "invalid-settled"
  | "invalid-content";

export type ScheduleResult = { ok: true; schedule: Schedule } | { ok: false; error: ScheduleError };

const shape = z.strictObject({
  channels: z.array(z.strictObject({
    id: z.string(),
    name: z.string(),
    group: z.strictObject({ id: z.string(), name: z.string() }),
  })),
  reminders: z.array(z.strictObject({
    key: z.string(),
    channel: z.string(),
    icon: z.literal("pill"),
    title: z.string(),
    lockScreen: z.strictObject({ title: z.string(), text: z.string() }),
    url: z.string(),
    recurrence: z.strictObject({ from: z.string(), until: z.string().nullable(), weekdays: z.array(z.number().int()) }),
    stages: z.array(z.strictObject({ at: z.string(), wake: z.enum(["exact", "alarmClock"]), text: z.string() })),
    actions: z.array(z.discriminatedUnion("kind", [
      z.strictObject({ id: z.string(), label: z.string(), kind: z.literal("settle") }),
      z.strictObject({ id: z.string(), label: z.string(), kind: z.literal("snooze"), minutes: z.number().int() }),
    ])),
    settled: z.array(z.string()),
    data: z.string(),
  })),
});

export function isLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const isLocalTime = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const ascending = (values: (string | number)[]) => values.every((value, index) => index === 0 || values[index - 1] < value);

export function parseSchedule(value: unknown): ScheduleResult {
  const parsed = shape.safeParse(value);
  if (!parsed.success) return { ok: false, error: "invalid-shape" };
  const input = parsed.data;
  const channels = new Set<string>();
  for (const channel of input.channels) {
    if (!channel.id || channels.has(channel.id) || !channel.name || !channel.group.id || !channel.group.name) return { ok: false, error: "invalid-channel" };
    channels.add(channel.id);
  }
  const keys = new Set<string>();
  for (const reminder of input.reminders) {
    const error = reminderError(reminder, keys, channels);
    if (error) return { ok: false, error };
    keys.add(reminder.key);
  }
  return { ok: true, schedule: input as Schedule };
}

function reminderError(reminder: z.infer<typeof shape>["reminders"][number], keys: Set<string>, channels: Set<string>): ScheduleError | null {
  const { recurrence, stages, actions, settled } = reminder;
  if (!reminder.key || keys.has(reminder.key)) return "invalid-key";
  if (!channels.has(reminder.channel)) return "invalid-channel";
  if (!isLocalDate(recurrence.from) || (recurrence.until !== null && !isLocalDate(recurrence.until)) || !settled.every(isLocalDate)) return "invalid-date";
  if (!recurrence.weekdays.length || !ascending(recurrence.weekdays) || recurrence.weekdays.some((day) => day < 1 || day > 7)) return "invalid-recurrence";
  if (recurrence.until !== null && recurrence.until < recurrence.from) return "invalid-recurrence";
  if (!stages.every((stage) => isLocalTime(stage.at))) return "invalid-time";
  if (!stages.length || !ascending(stages.map((stage) => stage.at))) return "invalid-stages";
  const actionIds = new Set<string>();
  if (actions.length > 3) return "invalid-actions";
  for (const action of actions) {
    if (!action.id || actionIds.has(action.id) || !action.label) return "invalid-actions";
    if (action.kind === "snooze" && (action.minutes < 1 || action.minutes > 1440)) return "invalid-actions";
    actionIds.add(action.id);
  }
  if (!ascending(settled)) return "invalid-settled";
  if (!reminder.title || !reminder.url || !reminder.lockScreen.title || !reminder.lockScreen.text || stages.some((stage) => !stage.text)) return "invalid-content";
  return null;
}
