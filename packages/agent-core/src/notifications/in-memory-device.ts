import { occursOn } from "./recurrence";
import { parseSchedule, type LocalDate, type NotificationDevice, type Receipt, type Schedule } from "./schedule";

export type InMemoryNotificationDevice = NotificationDevice & {
  queue: Receipt[];
  schedules: Map<string, Schedule>;
  quiesced: boolean;
  failInstall: boolean;
  isSettled(source: string, key: string, date: LocalDate): boolean;
};

const occurrence = (source: string, key: string, date: LocalDate) => JSON.stringify([source, key, date]);

export function createInMemoryNotificationDevice({ now = () => new Date().toISOString() }: { now?: () => string } = {}): InMemoryNotificationDevice {
  let sequence = 0;
  let owner: string | null = null;
  let settledHere = new Set<string>();
  const copy = (receipt: Receipt): Receipt => ({ ...receipt });
  const unacknowledgedSettles = () => device.queue.filter((receipt) => receipt.type === "settled");
  const reset = () => {
    owner = null;
    settledHere = new Set();
    device.queue = [];
    device.schedules = new Map();
    device.quiesced = false;
  };
  const device: InMemoryNotificationDevice = {
    queue: [],
    schedules: new Map(),
    quiesced: false,
    failInstall: false,
    isSettled(source, key, date) {
      const reminder = device.schedules.get(source)?.reminders.find((item) => item.key === key);
      return !!reminder?.settled.includes(date) || settledHere.has(occurrence(source, key, date));
    },
    async install(workspace, source, schedule) {
      if (device.failInstall) throw new Error("Native persistence failed");
      const parsed = parseSchedule(schedule);
      if (!parsed.ok) throw new Error(`Invalid schedule: ${parsed.error}`);
      if (owner !== null && owner !== workspace) {
        if (unacknowledgedSettles().length) throw new Error("Another workspace has unimported notification actions");
        reset();
      }
      owner = workspace;
      device.schedules.set(source, parsed.schedule);
      settledHere = new Set(unacknowledgedSettles().map((receipt) => occurrence(receipt.source, receipt.key, receipt.date)));
      device.quiesced = false;
    },
    async receipts(workspace, source) {
      return owner === workspace ? device.queue.filter((receipt) => receipt.source === source).map(copy) : [];
    },
    async acknowledge(workspace, source, receiptIds) {
      if (owner !== workspace) return;
      device.queue = device.queue.filter((receipt) => receipt.source !== source || !receiptIds.includes(receipt.id));
    },
    async settle(workspace, source, key, date, action) {
      if (device.quiesced || owner !== workspace) throw new Error("Closed");
      const reminder = device.schedules.get(source)?.reminders.find((item) => item.key === key);
      if (!reminder) throw new Error("Unknown reminder");
      if (!occursOn(reminder.recurrence, date)) throw new Error("The reminder does not occur on that date");
      if (!reminder.actions.some((item) => item.id === action && item.kind === "settle")) throw new Error("Not a settle action");
      const existing = device.queue.find((receipt) => receipt.type === "settled" && receipt.source === source && receipt.key === key && receipt.date === date);
      if (existing) return copy(existing);
      if (device.isSettled(source, key, date)) throw new Error("Already settled");
      const receipt: Receipt = { id: `receipt-${sequence++}`, source, key, date, at: now(), data: reminder.data, type: "settled", action };
      device.queue.push(receipt);
      settledHere.add(occurrence(source, key, date));
      return copy(receipt);
    },
    async quiesce(workspace) {
      if (owner === workspace) device.quiesced = true;
    },
    async clear(workspace) {
      if (owner === workspace) reset();
    },
  };
  return device;
}
