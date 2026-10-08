import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseSchedule, type Receipt, type Schedule } from "../notifications/schedule";
import { createInMemoryTaskdoReplica } from "../taskdo/in-memory";
import type { Dose, Medicine } from "./model";
import { MEDICINE_CHANNEL, medicineReceipt, medicineSchedule } from "./notifications";

const medicine = (over: Partial<Medicine> = {}): Medicine => ({
  id: "vitamin", name: "Vitamin D", instructions: "After food", startsOn: "2026-09-01", endsOn: null, paused: false,
  weekdays: [1, 3, 5], doses: [{ id: "morning", remindAt: "07:45", alarmAt: "08:00", amount: 1 }], createdAt: "2026-09-01T08:00:00.000Z", supply: null, ...over,
});
const taken = (on: string, slotId = "morning"): Dose => ({ id: `${slotId}-${on}`, medicineId: "vitamin", slotId, on, scheduledAt: `${on}T06:00:00.000Z`, takenAt: `${on}T06:05:00.000Z` });

describe("medicine notification schedule", () => {
  it("schedules each dose time of an active medicine with an early reminder and a dose-time alarm", () => {
    const schedule = medicineSchedule({ medicines: [medicine()], doses: [] });
    expect(parseSchedule(schedule).ok).toBe(true);
    expect(schedule.channels.map((channel) => channel.id)).toEqual([MEDICINE_CHANNEL]);
    const [reminder] = schedule.reminders;
    expect(reminder.recurrence).toEqual({ from: "2026-09-01", until: null, weekdays: [1, 3, 5] });
    expect(reminder.stages).toEqual([
      { at: "07:45", wake: "exact", text: "Take 1 pill at 08:00 · After food" },
      { at: "08:00", wake: "alarmClock", text: "Time to take 1 pill · After food", fullScreen: true },
    ]);
    expect(reminder.actions.map((action) => action.label)).toEqual(["Taken", "Postpone 1 hour"]);
    expect(reminder.url).toBe("zeroagent:///browse/medicines/vitamin?slot=morning&date={date}");
  });

  it("leaves paused medicines out", () => {
    expect(medicineSchedule({ medicines: [medicine({ paused: true })], doses: [] }).reminders).toEqual([]);
  });

  it("lists every taken date of a dose time, oldest first", () => {
    const schedule = medicineSchedule({ medicines: [medicine()], doses: [taken("2026-10-02"), taken("2026-09-02"), { ...taken("2026-10-05"), takenAt: null }] });
    expect(schedule.reminders[0].settled).toEqual(["2026-09-02", "2026-10-02"]);
  });

  it("omits blank instructions from the text", () => {
    const schedule = medicineSchedule({ medicines: [medicine({ instructions: "  " })], doses: [] });
    expect(schedule.reminders[0].stages.map((stage) => stage.text)).toEqual(["Take 1 pill at 08:00", "Time to take 1 pill"]);
  });

  it("says how many pills each dose takes", () => {
    const schedule = medicineSchedule({ medicines: [medicine({ instructions: null, doses: [{ id: "morning", remindAt: "07:45", alarmAt: "08:00", amount: 2 }] })], doses: [] });
    expect(schedule.reminders[0].stages.map((stage) => stage.text)).toEqual(["Take 2 pills at 08:00", "Time to take 2 pills"]);
  });
});

type ReceiptContract = { zone: string; schedule: Schedule; receipts: Omit<Receipt, "id">[]; settledAt: string };

describe("native receipt contract", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("installs the schedule the engine is tested with and records the receipts it writes as a taken dose", async () => {
    const contract = JSON.parse(readFileSync(new URL("../notifications/conformance/receipts.json", import.meta.url), "utf8")) as ReceiptContract;
    process.env.TZ = contract.zone;
    const replica = createInMemoryTaskdoReplica();
    const id = "0d4c3f2e-8a51-4c7b-9f0e-2b6a1d9e7c31";
    await replica.medicines.add({ name: "Evening pill", instructions: null, startsOn: "2026-09-01", endsOn: null, paused: false, weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [{ id: "a3e9b1d2-5c47-4f68-8e12-7d0b9c4f6a85", remindAt: "19:45", alarmAt: "20:00", amount: 1 }] }, id);
    expect(medicineSchedule(replica.snapshot())).toEqual(contract.schedule);
    const receipts = contract.receipts.map((receipt, index) => medicineReceipt({ ...receipt, id: `receipt-${index}` } as Receipt)!);
    await replica.medicines.applyReceipts(receipts, "workspace");
    expect(replica.snapshot().doses.map((dose) => ({ on: dose.on, takenAt: dose.takenAt, scheduledAt: Date.parse(dose.scheduledAt) })))
      .toEqual([{ on: "2026-10-02", takenAt: contract.settledAt, scheduledAt: Date.parse("2026-10-02T18:00:00Z") }]);
    await replica.close();
  });
});
