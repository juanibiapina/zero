import { describe, expect, it, vi } from "vitest";
import { createInMemoryTaskdoReplica } from "../taskdo/in-memory";
import { createInMemoryMedicineReminderDevice } from "./in-memory-device";
import { createMedicineReminders } from "./reminders";
import { medicineOccurrences } from "./model";

async function setup() {
  const replica = createInMemoryTaskdoReplica();
  const medicine = await replica.medicines.add({ name: "Pill", instructions: null, startsOn: "2026-10-02", endsOn: null, paused: false, weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [{ id: "evening", remindAt: "20:00", alarmAt: "22:00" }] });
  const dose = medicineOccurrences(medicine, "2026-10-02")[0];
  const device = createInMemoryMedicineReminderDevice({ takenAt: () => "2026-10-02T20:35:00Z" }); const controller = createMedicineReminders(replica, device, "workspace");
  await controller.enable(); return { replica, device, controller, dose };
}
describe("medicine reminder durability", () => {
  it("does not replace native alarms for an unrelated Task mutation", async () => {
    const { replica, device, controller } = await setup();
    const replace = vi.spyOn(device, "replace");
    await replica.tasks.add("Unrelated task").isPersisted.promise;
    expect(replace).not.toHaveBeenCalled();
    await controller.close(); await replica.close();
  });
  it("keeps a winning Undo unsuppressed when it arrives before native receipt reconciliation", async () => {
    const { replica, device, controller, dose } = await setup();
    await device.take("workspace", dose);
    const save = replica.saveLocal;
    let undo = true;
    replica.saveLocal = async () => {
      await save();
      if (undo) { undo = false; await replica.medicines.undo(dose.id); }
    };
    await controller.refresh();
    expect(replica.snapshot().doses[0]?.takenAt).toBeNull();
    expect(device.confirmed.has(dose.id)).toBe(false);
    expect(device.queue).toHaveLength(0);
    await controller.close(); await replica.close();
  });
  it("does not suppress an undone dose when an acknowledged receipt is replayed", async () => {
    const { replica, device, controller, dose } = await setup();
    const receipt = await device.take("workspace", dose);
    await controller.refresh();
    await controller.undo(dose.id);
    device.queue.push(receipt); device.confirmed.add(dose.id);
    await controller.refresh();
    expect(replica.snapshot().doses[0]?.takenAt).toBeNull();
    expect(device.confirmed.has(dose.id)).toBe(false);
    expect(device.queue).toHaveLength(0);
    await controller.close(); await replica.close();
  });
  it("keeps notification receipts on close so account locking and explicit discard need no import", async () => {
    const { replica, device, controller, dose } = await setup();
    await device.take("workspace", dose);
    await controller.close();
    expect(device.quiesced).toBe(true);
    expect(device.queue).toHaveLength(1);
    expect(replica.snapshot().doses).toEqual([]);
    await expect(device.take("workspace", dose)).rejects.toThrow("Closed");
    await replica.close();
  });
  it("retains a fresh receipt received after capture while a native plan is being replaced", async () => {
    const { replica, device, controller, dose } = await setup();
    const original = device.replace.bind(device);
    let inject = true;
    device.replace = async (workspace, plan) => {
      if (inject) { inject = false; await device.take(workspace, dose); }
      await original(workspace, plan);
    };
    await controller.refresh();
    expect(replica.snapshot().doses).toEqual([]);
    expect(device.queue).toHaveLength(1);
    expect(device.confirmed.has(dose.id)).toBe(true);
    await controller.refresh();
    expect(replica.snapshot().doses[0]?.takenAt).toBe("2026-10-02T20:35:00Z");
    expect(device.queue).toHaveLength(0);
    expect(device.confirmed.has(dose.id)).toBe(true);
    await controller.close(); await replica.close();
  });
  it("installs an edit received while native delivery acknowledgment is pending", async () => {
    const { replica, device, controller } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = device.replace.bind(device);
    let delay = true;
    device.replace = async (workspace, plan) => {
      if (delay) { delay = false; await gate; }
      await original(workspace, plan);
    };
    const refresh = controller.refresh();
    await vi.waitFor(() => expect(delay).toBe(false));
    expect(controller.getState().pending).toBe(true);
    const medicine = replica.snapshot().medicines[0];
    await replica.medicines.edit(medicine.id, { ...medicine, name: "Edited during install" });
    release();
    await refresh;
    expect(device.plan?.medicines[0]?.name).toBe("Edited during install");
    expect(controller.getState().pending).toBe(false);
    await controller.close(); await replica.close();
  });
  it("keeps native suppression and a replayable receipt when native replacement fails", async () => {
    const { replica, device, controller, dose } = await setup(); device.failReplacement = true;
    await expect(controller.take(dose)).rejects.toThrow("Native persistence failed");
    expect(device.confirmed.has(dose.id)).toBe(true);
    expect(device.queue).toHaveLength(1);
    expect(replica.snapshot().doses[0]?.takenAt).toBe("2026-10-02T20:35:00Z");
    device.failReplacement = false; await controller.refresh();
    expect(device.queue).toHaveLength(0); expect(device.confirmed.has(dose.id)).toBe(true);
    await controller.close(); await replica.close();
  });
  it("imports notification confirmations before checkpoint and keeps receiver acceptance closed", async () => {
    const { replica, device, controller, dose } = await setup(); await device.take("workspace", dose);
    await controller.checkpoint();
    expect(replica.snapshot().doses[0]?.takenAt).toBe("2026-10-02T20:35:00Z");
    expect(device.quiesced).toBe(true); expect(device.queue).toHaveLength(0);
    await expect(device.take("workspace", dose)).rejects.toThrow("Closed");
    await controller.close(); await replica.close();
  });
  it("imports older notification receipts before Undo instead of recreating their confirmation", async () => {
    const { replica, device, controller, dose } = await setup(); await device.take("workspace", dose);
    await controller.undo(dose.id);
    expect(replica.snapshot().doses[0]?.takenAt).toBeNull();
    expect(device.confirmed.has(dose.id)).toBe(false); expect(device.queue).toHaveLength(0);
    await controller.close(); await replica.close();
  });
});
