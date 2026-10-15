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

const COURSE_LIMIT_DAYS = 36500;

export type CourseEnd = { endsOn: string; endsBefore: string | null };

export function lastPillDay(medicine: Pick<Medicine, "startsOn" | "weekdays" | "doses">, pillsLeft: number, settledToday: ReadonlySet<string>, today: string): CourseEnd {
  const recurrence = { from: medicine.startsOn, until: null, weekdays: medicine.weekdays };
  const slots = [...medicine.doses].sort((a, b) => a.alarmAt.localeCompare(b.alarmAt));
  const weekly = weeklyPills(medicine);
  let pills = pillsLeft;
  let last: string | null = null;
  let cut = null as CourseEnd | null;
  let day = today < medicine.startsOn ? medicine.startsOn : today;
  const walk = (days: number): boolean => {
    for (let step = 0; step < days; step += 1, day = addDays(day, 1)) {
      if (!occursOn(recurrence, day)) continue;
      let earlier = false;
      for (const slot of slots) {
        if (day === today && settledToday.has(slot.id)) { earlier = true; continue; }
        if (pills < slot.amount) {
          if (earlier) cut = { endsOn: day, endsBefore: slot.alarmAt };
          return false;
        }
        pills -= slot.amount;
        last = day;
        earlier = true;
      }
    }
    return true;
  };
  if (walk(7)) {
    if (weekly > 0 && pills >= weekly) {
      const weeks = Math.min(Math.floor(pills / weekly), Math.floor(COURSE_LIMIT_DAYS / 7));
      pills -= weeks * weekly;
      day = addDays(day, weeks * 7);
      for (let back = 1; back <= 7; back += 1) {
        if (occursOn(recurrence, addDays(day, -back))) { last = addDays(day, -back); break; }
      }
    }
    walk(7);
  }
  if (cut) return cut;
  const end = last ?? (today >= medicine.startsOn && settledToday.size ? today : addDays(today, -1));
  return { endsOn: end < medicine.startsOn ? medicine.startsOn : end, endsBefore: null };
}

export function supplyIsLow(medicine: Medicine, today: string): boolean {
  const supply = medicine.supply;
  if (!supply || medicine.untilEmpty) return false;
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
