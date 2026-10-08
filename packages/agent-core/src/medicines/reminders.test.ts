import { describe, expect, it, vi } from "vitest";
import { createInMemoryTaskdoReplica } from "../taskdo/in-memory";
import { createInMemoryNotificationDevice } from "../notifications/in-memory-device";
import { createMedicineReminders } from "./reminders";
import { medicineOccurrences, type Dose } from "./model";
import { MEDICINE_SOURCE, medicineOccurrence } from "./notifications";

async function setup() {
  const replica = createInMemoryTaskdoReplica();
  const medicine = await replica.medicines.add({ name: "Pill", instructions: null, startsOn: "2026-10-02", endsOn: null, paused: false, weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [{ id: "evening", remindAt: "20:00", alarmAt: "22:00", amount: 1 }] });
  const dose = medicineOccurrences(medicine, "2026-10-02")[0];
  const device = createInMemoryNotificationDevice({ now: () => "2026-10-02T20:35:00Z" });
  const controller = createMedicineReminders(replica, device, "workspace");
  await controller.enable();
  const settle = () => { const { key, date } = medicineOccurrence(dose); return device.settle("workspace", MEDICINE_SOURCE, key, date, "taken"); };
  const settled = (target: Dose = dose) => { const { key, date } = medicineOccurrence(target); return device.isSettled(MEDICINE_SOURCE, key, date); };
  return { replica, device, controller, dose, medicine, settle, settled };
}

describe("medicine reminder durability", () => {
  it("does not reinstall notifications for an unrelated Task mutation", async () => {
    const { replica, device, controller } = await setup();
    const install = vi.spyOn(device, "install");
    await replica.tasks.add("Unrelated task").isPersisted.promise;
    expect(install).not.toHaveBeenCalled();
    await controller.close(); await replica.close();
  });

  it("keeps a winning Undo unsettled when it arrives before the notification receipt is reconciled", async () => {
    const { replica, device, controller, dose, settle, settled } = await setup();
    await settle();
    const save = replica.saveLocal;
    let undo = true;
    replica.saveLocal = async () => {
      await save();
      if (undo) { undo = false; await replica.medicines.undo(dose.id); }
    };
    await controller.refresh();
    expect(replica.snapshot().doses[0]?.takenAt).toBeNull();
    expect(settled()).toBe(false);
    expect(device.queue).toHaveLength(0);
    await controller.close(); await replica.close();
  });

  it("does not settle an undone dose when an acknowledged receipt is replayed", async () => {
    const { replica, device, controller, dose, settle, settled } = await setup();
    const receipt = await settle();
    await controller.refresh();
    await controller.undo(dose.id);
    device.queue.push(receipt);
    await controller.refresh();
    expect(replica.snapshot().doses[0]?.takenAt).toBeNull();
    expect(settled()).toBe(false);
    expect(device.queue).toHaveLength(0);
    await controller.close(); await replica.close();
  });

  it("keeps notification receipts on close so account locking and explicit discard need no import", async () => {
    const { replica, device, controller, settle } = await setup();
    await settle();
    await controller.close();
    expect(device.quiesced).toBe(true);
    expect(device.queue).toHaveLength(1);
    expect(replica.snapshot().doses).toEqual([]);
    await expect(settle()).rejects.toThrow("Closed");
    await replica.close();
  });

  it("keeps a Taken that arrives during an install silenced until it is imported", async () => {
    const { replica, device, controller, settle, settled } = await setup();
    const original = device.install.bind(device);
    let inject = true;
    device.install = async (workspace, source, schedule) => {
      if (inject) { inject = false; await settle(); }
      await original(workspace, source, schedule);
    };
    await controller.refresh();
    expect(replica.snapshot().doses).toEqual([]);
    expect(device.queue).toHaveLength(1);
    expect(settled()).toBe(true);
    await controller.refresh();
    expect(replica.snapshot().doses[0]?.takenAt).toBe("2026-10-02T20:35:00Z");
    expect(device.queue).toHaveLength(0);
    expect(settled()).toBe(true);
    await controller.close(); await replica.close();
  });

  it("installs an edit received while an install is pending", async () => {
    const { replica, device, controller } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = device.install.bind(device);
    let delay = true;
    device.install = async (workspace, source, schedule) => {
      if (delay) { delay = false; await gate; }
      await original(workspace, source, schedule);
    };
    const refresh = controller.refresh();
    await vi.waitFor(() => expect(delay).toBe(false));
    expect(controller.getState().pending).toBe(true);
    const medicine = replica.snapshot().medicines[0];
    await replica.medicines.edit(medicine.id, { ...medicine, name: "Edited during install" });
    release();
    await refresh;
    expect(device.schedules.get(MEDICINE_SOURCE)?.reminders[0]?.title).toBe("Edited during install");
    expect(controller.getState().pending).toBe(false);
    await controller.close(); await replica.close();
  });

  it("keeps the dose silenced and its confirmation saved when the install fails", async () => {
    const { replica, device, controller, dose, settled } = await setup();
    device.failInstall = true;
    await expect(controller.take(dose)).rejects.toThrow("Native persistence failed");
    expect(settled()).toBe(true);
    expect(replica.snapshot().doses[0]?.takenAt).toBe("2026-10-02T20:35:00Z");
    device.failInstall = false;
    await controller.refresh();
    expect(device.queue).toHaveLength(0);
    expect(settled()).toBe(true);
    await controller.close(); await replica.close();
  });

  it("imports notification confirmations before checkpoint and keeps Taken closed", async () => {
    const { replica, device, controller, settle } = await setup();
    await settle();
    await controller.checkpoint();
    expect(replica.snapshot().doses[0]?.takenAt).toBe("2026-10-02T20:35:00Z");
    expect(device.quiesced).toBe(true);
    expect(device.queue).toHaveLength(0);
    await expect(settle()).rejects.toThrow("Closed");
    await controller.close(); await replica.close();
  });

  it("imports older notification receipts before Undo instead of recreating their confirmation", async () => {
    const { replica, device, controller, dose, settle, settled } = await setup();
    await settle();
    await controller.undo(dose.id);
    expect(replica.snapshot().doses[0]?.takenAt).toBeNull();
    expect(settled()).toBe(false);
    expect(device.queue).toHaveLength(0);
    await controller.close(); await replica.close();
  });

  it("records the dose time a notification Taken was scheduled for after the dose time changes", async () => {
    const { replica, controller, dose, medicine, settle } = await setup();
    await settle();
    await replica.medicines.edit(medicine.id, { ...medicine, doses: [{ id: "evening", remindAt: "20:00", alarmAt: "21:00", amount: 1 }] });
    await controller.refresh();
    const taken = replica.snapshot().doses.find((item) => item.id === dose.id);
    expect(taken?.takenAt).toBe("2026-10-02T20:35:00Z");
    expect(taken?.scheduledAt).toBe(new Date("2026-10-02T22:00:00").toISOString());
    await controller.close(); await replica.close();
  });
});
