import type { Dose, MedicineReceipt } from "./model";
import type { MedicineReminderPort, ReminderPlan } from "./reminders";

export type InMemoryMedicineReminderDevice = MedicineReminderPort & {
  clear(workspace: string): Promise<void>;
  queue: MedicineReceipt[];
  confirmed: Set<string>;
  plan: ReminderPlan | null;
  quiesced: boolean;
  failReplacement: boolean;
};

export function createInMemoryMedicineReminderDevice({ takenAt = () => new Date().toISOString() }: { takenAt?: () => string } = {}): InMemoryMedicineReminderDevice {
  let sequence = 0;
  const device: InMemoryMedicineReminderDevice = {
    queue: [],
    confirmed: new Set(),
    plan: null,
    quiesced: false,
    failReplacement: false,
    async receipts() { return device.queue.map((receipt) => ({ ...receipt })); },
    async replace(_workspace: string, plan: ReminderPlan) {
      if (device.failReplacement) throw new Error("Native persistence failed");
      device.plan = plan;
      device.confirmed = new Set(plan.confirmed);
      for (const receipt of device.queue) {
        if (receipt.kind === "taken" && !plan.processedActions?.includes(receipt.actionId)) device.confirmed.add(receipt.id);
      }
      device.quiesced = false;
    },
    async acknowledge(_workspace: string, actionIds: string[]) {
      device.queue = device.queue.filter((receipt) => !actionIds.includes(receipt.actionId));
    },
    async take(_workspace: string, dose: Dose) {
      if (device.quiesced) throw new Error("Closed");
      const receipt: MedicineReceipt = { ...dose, kind: "taken", actionId: `receipt-${sequence++}`, takenAt: takenAt() };
      device.queue.push(receipt);
      device.confirmed.add(receipt.id);
      return { ...receipt };
    },
    async quiesce() { device.quiesced = true; },
    async clear() {
      device.queue = [];
      device.confirmed = new Set();
      device.plan = null;
      device.quiesced = false;
    },
  };
  return device;
}
