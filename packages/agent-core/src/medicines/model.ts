import type { MergeableStore } from "tinybase";
import { nextOccurrence, occursOn } from "../notifications/recurrence";
import type { Recurrence, Weekday } from "../notifications/schedule";

export type { Weekday };
export type MedicineSlot = { id: string; remindAt: string; alarmAt: string };
export const EVERY_DAY: Weekday[] = [1, 2, 3, 4, 5, 6, 7];
export type Medicine = {
  id: string; name: string; instructions: string | null;
  startsOn: string; endsOn: string | null; paused: boolean;
  weekdays: Weekday[];
  doses: MedicineSlot[]; createdAt: string;
};
export type MedicineInput = Omit<Medicine, "id" | "createdAt">;
export type Dose = {
  id: string; medicineId: string; slotId: string; on: string;
  scheduledAt: string; takenAt: string | null;
};
export type MedicineReceipt = Dose & { actionId: string; kind: "presented" | "taken" };
export type MedicineRecovery = { table: "medicines" | "doses"; id: string; text: string; reason: string };
export type MedicineSnapshot = { medicines: Medicine[]; doses: Dose[]; recoveries: MedicineRecovery[] };

export function medicineToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function medicineEndDate(start: string, days: number): string {
  if (!validDay(start) || !Number.isInteger(days) || days < 1 || days > 36500) throw new Error("Enter a whole number of days between 1 and 36500");
  const date = new Date(`${start}T12:00:00`);
  date.setDate(date.getDate() + days - 1);
  return medicineToday(date);
}
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export function medicineRecurrence(medicine: Pick<Medicine, "startsOn" | "endsOn" | "weekdays">): Recurrence {
  return { from: medicine.startsOn, until: medicine.endsOn, weekdays: medicine.weekdays };
}
export function medicineDueOn(medicine: Medicine, on: string): boolean {
  return !medicine.paused && occursOn(medicineRecurrence(medicine), on);
}
export function medicineNextDay(medicine: Medicine, from: string): string | null {
  return nextOccurrence(medicineRecurrence(medicine), from);
}
export function medicineCadence(medicine: Pick<MedicineInput, "weekdays" | "doses">): string {
  const count = medicine.doses.length;
  if (medicine.weekdays.length === 7) return count === 1 ? "Once a day" : `${count} times a day`;
  const days = medicine.weekdays.map((weekday) => WEEKDAY_NAMES[weekday - 1]).join(", ");
  return count === 1 ? days : `${count} times on ${days}`;
}
export function doseId(medicineId: string, slotId: string, on: string): string {
  return JSON.stringify([medicineId, slotId, on]);
}
function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && medicineToday(date) === value;
}
const validTime = (value: unknown): value is string => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const validInstant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
function parse<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}
export function validateMedicine(input: MedicineInput): void {
  if (!input.name?.trim()) throw new Error("Enter a medicine name");
  if (!validDay(input.startsOn) || (input.endsOn !== null && (!validDay(input.endsOn) || input.endsOn < input.startsOn))) throw new Error("The last day must be on or after the start date");
  if (typeof input.paused !== "boolean" || (input.instructions !== null && typeof input.instructions !== "string")) throw new Error("Invalid medicine details");
  if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.some((day, index) => !Number.isInteger(day) || day < 1 || day > 7 || (index > 0 && day <= input.weekdays[index - 1]))) throw new Error("Choose at least one day of the week");
  if (!Array.isArray(input.doses) || !input.doses.length || input.doses.length > 24) throw new Error("Add between 1 and 24 daily dose times");
  const ids = new Set<string>(); const times = new Set<string>();
  for (const slot of input.doses) {
    if (!slot || typeof slot.id !== "string" || !slot.id || ids.has(slot.id)) throw new Error("Each dose needs its own identity");
    if (!validTime(slot.remindAt) || !validTime(slot.alarmAt) || slot.remindAt >= slot.alarmAt) throw new Error("The reminder must be earlier than its alarm on the same day");
    if (times.has(slot.alarmAt)) throw new Error("Choose a different alarm time for each daily dose");
    ids.add(slot.id); times.add(slot.alarmAt);
  }
}
export function medicineState(medicine: Medicine, on = medicineToday()): "scheduled" | "active" | "paused" | "ended" {
  if (medicine.endsOn && on > medicine.endsOn) return "ended";
  if (medicine.paused) return "paused";
  return on < medicine.startsOn ? "scheduled" : "active";
}
export function medicineOccurrences(medicine: Medicine, on = medicineToday()): Dose[] {
  if (!medicineDueOn(medicine, on)) return [];
  return medicine.doses.map((slot) => ({ id: doseId(medicine.id, slot.id, on), medicineId: medicine.id, slotId: slot.id, on,
    scheduledAt: new Date(`${on}T${slot.alarmAt}:00`).toISOString(), takenAt: null }));
}

export class MedicineModel {
  constructor(private readonly store: MergeableStore, private readonly now: () => Date = () => new Date()) {}

  get(id: string): Medicine | null {
    const row = this.store.getRow("medicines", id);
    if (row.deletedAt) return null;
    const stored = parse<MedicineInput>(row.details);
    if (!stored || typeof stored !== "object" || !validInstant(row.createdAt)) return null;
    const details: MedicineInput = { ...stored, weekdays: "weekdays" in stored ? stored.weekdays : EVERY_DAY };
    try { validateMedicine(details); } catch { return null; }
    return { ...details, id, name: details.name.trim(), createdAt: row.createdAt };
  }

  snapshot(): MedicineSnapshot {
    const medicines: Medicine[] = []; const doses: Dose[] = []; const recoveries: MedicineRecovery[] = [];
    for (const id of this.store.getRowIds("medicines")) {
      if (this.store.getCell("medicines", id, "deletedAt")) continue;
      const medicine = this.get(id);
      if (medicine) medicines.push(medicine);
      else recoveries.push({ table: "medicines", id, text: id, reason: "Invalid Medicine schedule; reminders disabled" });
    }
    for (const id of this.store.getRowIds("doses")) {
      const dose = this.getDose(id);
      const parentId = this.store.getCell("doses", id, "medicineId");
      if (typeof parentId === "string" && this.store.getCell("medicines", parentId, "deletedAt")) continue;
      if (dose && this.get(dose.medicineId)) doses.push(dose);
      else recoveries.push({ table: "doses", id, text: id, reason: "Invalid or orphaned Dose" });
    }
    medicines.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    doses.sort((a, b) => b.on.localeCompare(a.on) || a.scheduledAt.localeCompare(b.scheduledAt));
    return { medicines, doses, recoveries };
  }

  add(id: string, input: MedicineInput): Medicine {
    if (this.store.hasRow("medicines", id)) throw new Error("Medicine already exists");
    validateMedicine(input);
    this.store.setRow("medicines", id, { details: JSON.stringify({ ...input, name: input.name.trim() }), createdAt: this.now().toISOString() });
    return this.get(id)!;
  }
  edit(id: string, input: MedicineInput): void {
    if (!this.get(id)) throw new Error("Medicine was deleted or is not on this device");
    validateMedicine(input);
    this.store.setCell("medicines", id, "details", JSON.stringify({ ...input, name: input.name.trim() }));
  }
  remove(id: string): void {
    if (!this.get(id)) return;
    this.store.transaction(() => {
      for (const doseId of this.store.getRowIds("doses")) {
        if (this.store.getCell("doses", doseId, "medicineId") === id) this.store.delRow("doses", doseId);
      }
      this.store.setRow("medicines", id, { deletedAt: this.now().toISOString() });
    });
  }
  getDose(id: string): Dose | null {
    const row = this.store.getRow("doses", id);
    const confirmation = parse<{ takenAt: string | null; scheduledAt: string; actionId: string }>(row.confirmation);
    if (typeof row.medicineId !== "string" || typeof row.slotId !== "string" || !validDay(row.on) || !validInstant(row.scheduledAt) || doseId(row.medicineId, row.slotId, row.on) !== id) return null;
    if (row.confirmation !== undefined && (!confirmation || typeof confirmation.actionId !== "string" || !confirmation.actionId || !validInstant(confirmation.scheduledAt) || (confirmation.takenAt !== null && !validInstant(confirmation.takenAt)))) return null;
    const medicine = this.get(row.medicineId);
    const pending = medicine && row.on >= medicineToday(this.now())
      ? medicineOccurrences(medicine, row.on).find((dose) => dose.slotId === row.slotId)?.scheduledAt
      : undefined;
    return { id, medicineId: row.medicineId, slotId: row.slotId, on: row.on,
      scheduledAt: confirmation?.takenAt ? confirmation.scheduledAt : pending ?? row.scheduledAt,
      takenAt: confirmation?.takenAt ?? null };
  }
  present(dose: Dose): void {
    if (!this.get(dose.medicineId)) return;
    if (!validDay(dose.on) || !validInstant(dose.scheduledAt) || dose.id !== doseId(dose.medicineId, dose.slotId, dose.on)) throw new Error("Invalid Dose");
    const existing = this.getDose(dose.id);
    if (!existing) this.store.setRow("doses", dose.id, { medicineId: dose.medicineId, slotId: dose.slotId, on: dose.on, scheduledAt: dose.scheduledAt });
    else if (!existing.takenAt && dose.on >= medicineToday(this.now())) this.store.setCell("doses", dose.id, "scheduledAt", dose.scheduledAt);
  }
  take(dose: Dose, actionId: string, takenAt = this.now().toISOString()): void {
    if (!validInstant(takenAt)) throw new Error("Invalid confirmation time");
    this.present(dose);
    if (!this.get(dose.medicineId)) return;
    if (this.getDose(dose.id)?.takenAt) return;
    this.store.setCell("doses", dose.id, "confirmation", JSON.stringify({ actionId, takenAt, scheduledAt: dose.scheduledAt }));
  }
  undo(id: string, actionId: string): void {
    const dose = this.getDose(id);
    if (!dose || !this.get(dose.medicineId)) return;
    this.store.setCell("doses", id, "confirmation", JSON.stringify({ actionId, takenAt: null, scheduledAt: dose.scheduledAt }));
  }
  applyReceipts(receipts: MedicineReceipt[], deviceId: string): void {
    this.store.transaction(() => {
      for (const receipt of receipts) {
        const marker = JSON.stringify([deviceId, receipt.actionId]);
        if (this.store.hasRow("medicineReceipts", marker)) continue;
        if (receipt.kind === "taken" && receipt.takenAt) this.take(receipt, receipt.actionId, receipt.takenAt);
        else this.present(receipt);
        this.store.setRow("medicineReceipts", marker, { consumed: true });
      }
    });
  }
}
