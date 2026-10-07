import type { Dose, MedicineReceipt } from "./model";
import type { TaskdoReplica } from "../taskdo/replica";
import type { NotificationDevice, Schedule } from "../notifications/schedule";
import { MEDICINE_SOURCE, medicineOccurrence, medicineReceipt, medicineSchedule } from "./notifications";

export function createMedicineReminders(replica: TaskdoReplica, device: NotificationDevice, workspace: string) {
  let tail = Promise.resolve();
  let closed = false;
  let enabled = false;
  let error: string | null = null;
  let reconciling = false;
  let suspended = false;
  let pending = 0;
  let reconciledPlan: string | null = null;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const plan = (): Schedule => medicineSchedule(replica.snapshot());
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    pending += 1;
    publish();
    const run = tail.then(async () => {
      try {
        if (closed) throw new Error("Medicine reminder workspace is closed");
        const result = await operation();
        error = null;
        return result;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      } finally { pending -= 1; publish(); }
    });
    tail = run.then(() => {}, () => {});
    return run;
  };
  const flush = async (quiesced = false) => {
    reconciling = true;
    try {
      let installed: string;
      do {
        const receipts = await device.receipts(workspace, MEDICINE_SOURCE);
        const doses = receipts.map(medicineReceipt).filter((receipt): receipt is MedicineReceipt => receipt !== null);
        if (doses.length) await replica.medicines.applyReceipts(doses, workspace);
        await replica.saveLocal();
        if (receipts.length) await device.acknowledge(workspace, MEDICINE_SOURCE, receipts.map((receipt) => receipt.id));
        const next = plan();
        installed = JSON.stringify(next);
        if (!quiesced && enabled && !suspended) await device.install(workspace, MEDICINE_SOURCE, next);
        reconciledPlan = installed;
        // A sync can publish while the install is in flight.
        // Install that newer state before reporting delivery success.
      } while (!quiesced && enabled && !suspended && installed !== JSON.stringify(plan()));
    } finally { reconciling = false; }
  };
  const refresh = () => enqueue(() => flush());
  const unsubscribe = replica.subscribe(() => {
    if (enabled && !suspended && !reconciling && !closed && JSON.stringify(plan()) !== reconciledPlan) void refresh().catch(() => {});
  });
  return {
    workspace,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getState: () => ({ enabled, error, pending: pending > 0 }),
    enable: () => enqueue(async () => { enabled = true; await flush(); }),
    refresh,
    async take(dose: Dose) {
      await enqueue(async () => {
        if (!enabled) { await replica.medicines.take(dose); return; }
        const { key, date } = medicineOccurrence(dose);
        await device.settle(workspace, MEDICINE_SOURCE, key, date, "taken");
        await flush();
      });
    },
    undo: (id: string) => enqueue(async () => { await flush(); await replica.medicines.undo(id); await flush(); }),
    checkpoint: () => enqueue(async () => { suspended = true; await device.quiesce(workspace); await flush(true); }),
    resume: () => enqueue(async () => { suspended = false; if (enabled) await flush(); }),
    async close() {
      unsubscribe();
      await enqueue(async () => { suspended = true; await device.quiesce(workspace); });
      closed = true;
      listeners.clear();
    },
  };
}
export type MedicineReminders = ReturnType<typeof createMedicineReminders>;
