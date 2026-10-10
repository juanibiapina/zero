import type { Channel, Receipt, Reminder, Schedule } from "../notifications/schedule";
import { pillCount } from "./supply";
import { doseId, medicineLead, medicineRecurrence, type Dose, type Medicine, type MedicineReceipt } from "./model";

export const MEDICINE_SOURCE = "medicines";
export const MEDICINE_CHANNEL = "medicine-alerts-v2";

const channel: Channel = { id: MEDICINE_CHANNEL, name: "Medicine reminders", group: { id: "medicines", name: "Medicines" } };

export function medicineReminderKey(medicineId: string, slotId: string): string {
  return JSON.stringify([medicineId, slotId]);
}

const withInstructions = (text: string, instructions: string | null) => [text, instructions ?? ""].filter((part) => part.trim()).join(" · ");

export function medicineSchedule(snapshot: { medicines: Medicine[]; doses: Dose[] }): Schedule {
  const settled = new Map<string, Set<string>>();
  for (const dose of snapshot.doses) {
    if (!dose.takenAt && !dose.skippedAt) continue;
    const key = medicineReminderKey(dose.medicineId, dose.slotId);
    settled.set(key, (settled.get(key) ?? new Set()).add(dose.on));
  }
  const reminders: Reminder[] = [];
  for (const medicine of snapshot.medicines) {
    if (medicine.paused) continue;
    for (const slot of medicine.doses) {
      const key = medicineReminderKey(medicine.id, slot.id);
      reminders.push({
        key,
        channel: MEDICINE_CHANNEL,
        icon: "pill",
        title: medicine.name,
        lockScreen: { title: "Medicine reminder", text: "Open Zero Agent for details" },
        url: `zeroagent:///browse/medicines/${encodeURIComponent(medicine.id)}?slot=${encodeURIComponent(slot.id)}&date={date}`,
        recurrence: medicineRecurrence(medicine),
        at: slot.alarmAt,
        stages: [
          { offset: -medicineLead(slot), wake: "exact", text: withInstructions(`Take ${pillCount(slot.amount)} at ${slot.alarmAt}`, medicine.instructions) },
          {
            offset: 0, wake: "alarmClock", title: `${medicine.name} is due`, icon: "warning", tone: "warning", fullScreen: true,
            text: withInstructions(`Due at ${slot.alarmAt} · take ${pillCount(slot.amount)}`, medicine.instructions),
          },
        ],
        actions: [
          { id: "taken", label: "Taken", kind: "settle" },
          { id: "postpone", label: "Postpone 1 hour", kind: "snooze", minutes: 60 },
          { id: "skip", label: "Skip", kind: "settle" },
        ],
        settled: [...(settled.get(key) ?? [])].sort(),
        data: JSON.stringify({ alarmAt: slot.alarmAt }),
      });
    }
  }
  return { channels: [channel], reminders };
}

export function medicineOccurrence(dose: Pick<Dose, "medicineId" | "slotId" | "on">): { key: string; date: string } {
  return { key: medicineReminderKey(dose.medicineId, dose.slotId), date: dose.on };
}

function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

export function medicineReceipt(receipt: Receipt): MedicineReceipt | null {
  if (receipt.source !== MEDICINE_SOURCE) return null;
  const key = parse(receipt.key);
  const data = parse(receipt.data) as { alarmAt?: unknown } | null;
  if (!Array.isArray(key) || key.length !== 2 || !key.every((part) => typeof part === "string")) return null;
  if (!data || typeof data.alarmAt !== "string") return null;
  const [medicineId, slotId] = key as [string, string];
  const scheduledAt = new Date(`${receipt.date}T${data.alarmAt}:00`);
  if (!Number.isFinite(scheduledAt.getTime())) return null;
  const dose: Dose = { id: doseId(medicineId, slotId, receipt.date), medicineId, slotId, on: receipt.date, scheduledAt: scheduledAt.toISOString(), takenAt: null, skippedAt: null };
  if (receipt.type === "presented") return { ...dose, actionId: receipt.id, kind: "presented" };
  if (receipt.action === "taken") return { ...dose, actionId: receipt.id, kind: "taken", takenAt: receipt.at };
  if (receipt.action === "skip") return { ...dose, actionId: receipt.id, kind: "skipped", skippedAt: receipt.at };
  return null;
}
