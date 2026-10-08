import { addDays, occursOn } from "../notifications/recurrence";
import type { Medicine } from "./model";

export const DEFAULT_LEAD_DAYS = 14;

export const pillCount = (count: number) => `${count} ${count === 1 ? "pill" : "pills"}`;

type Schedule = Pick<Medicine, "weekdays" | "doses">;

export function pillsPerDay(medicine: Pick<Medicine, "doses">): number {
  return medicine.doses.reduce((sum, slot) => sum + slot.amount, 0);
}

export function weeklyPills(medicine: Schedule): number {
  return medicine.weekdays.length * pillsPerDay(medicine);
}

export function restockThreshold(medicine: Schedule, leadDays: number): number {
  return Math.ceil(weeklyPills(medicine) * leadDays / 7);
}

function courseFitsIn(medicine: Medicine, pillsLeft: number, today: string): boolean {
  if (medicine.endsOn === null) return false;
  const recurrence = { from: medicine.startsOn, until: medicine.endsOn, weekdays: medicine.weekdays };
  const perDay = pillsPerDay(medicine);
  let needed = 0;
  for (let day = today < medicine.startsOn ? medicine.startsOn : today; day <= medicine.endsOn; day = addDays(day, 1)) {
    if (occursOn(recurrence, day)) needed += perDay;
    if (needed > pillsLeft) return false;
  }
  return true;
}

export function supplyIsLow(medicine: Medicine, today: string): boolean {
  const supply = medicine.supply;
  if (!supply) return false;
  if (medicine.paused || (medicine.endsOn !== null && today > medicine.endsOn)) return false;
  if (supply.pillsLeft > restockThreshold(medicine, supply.leadDays)) return false;
  return !courseFitsIn(medicine, supply.pillsLeft, today);
}

export function daysLeft(medicine: Medicine): number | null {
  const weekly = weeklyPills(medicine);
  if (!medicine.supply || medicine.paused || weekly === 0) return null;
  return Math.floor(medicine.supply.pillsLeft * 7 / weekly);
}

export function supplyLabel(medicine: Medicine): string | null {
  if (!medicine.supply) return null;
  const { pillsLeft } = medicine.supply;
  const pills = `${pillsLeft} ${pillsLeft === 1 ? "pill" : "pills"} left`;
  const days = daysLeft(medicine);
  return days === null ? pills : `${pills} · about ${days} ${days === 1 ? "day" : "days"}`;
}
