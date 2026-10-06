import type { Dose, Medicine, MedicineReceipt } from "./model";
import type { TaskdoReplica } from "../taskdo/replica";

export type ReminderPlan = {
  medicines: Medicine[];
  confirmed: string[];
  processedActions?: string[];
};

export type MedicineReminderPort = {
  replace(workspace: string, plan: ReminderPlan): Promise<void>;
  receipts(workspace: string): Promise<MedicineReceipt[]>;
  acknowledge(workspace: string, actionIds: string[]): Promise<void>;
  take(workspace: string, dose: Dose): Promise<MedicineReceipt>;
  quiesce(workspace: string): Promise<void>;
};

export function createMedicineReminders(replica: TaskdoReplica, native: MedicineReminderPort, workspace: string) {
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
  const plan = (): ReminderPlan => {
    const snapshot = replica.snapshot();
    return { medicines: snapshot.medicines, confirmed: snapshot.doses.filter((dose) => dose.takenAt).map((dose) => dose.id) };
  };
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
        const receipts = await native.receipts(workspace);
        const actionIds = receipts.map((receipt) => receipt.actionId);
        if (receipts.length) await replica.medicines.applyReceipts(receipts, workspace);
        await replica.saveLocal();
        const next = plan();
        installed = JSON.stringify(next);
        if (!quiesced && enabled && !suspended) {
          await native.replace(workspace, { ...next, processedActions: actionIds });
        }
        if (receipts.length) await native.acknowledge(workspace, actionIds);
        reconciledPlan = installed;
        // A sync can publish while the native replacement is awaiting its ack.
        // Persist and install that newer state before reporting delivery success.
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
        if (enabled) { await native.take(workspace, dose); await flush(); }
        else await replica.medicines.take(dose);
      });
    },
    undo: (id: string) => enqueue(async () => { await flush(); await replica.medicines.undo(id); await flush(); }),
    checkpoint: () => enqueue(async () => { suspended = true; await native.quiesce(workspace); await flush(true); }),
    resume: () => enqueue(async () => { suspended = false; if (enabled) await flush(); }),
    async close() {
      unsubscribe();
      await enqueue(async () => { suspended = true; await native.quiesce(workspace); });
      closed = true;
      listeners.clear();
    },
  };
}
export type MedicineReminders = ReturnType<typeof createMedicineReminders>;
