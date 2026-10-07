import type { LocalDate, Recurrence } from "./schedule";

function weekdayOf(date: LocalDate): number {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  return ((value.getUTCDay() + 6) % 7) + 1;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day + days);
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export function occursOn(recurrence: Recurrence, date: LocalDate): boolean {
  if (date < recurrence.from) return false;
  if (recurrence.until !== null && date > recurrence.until) return false;
  return (recurrence.weekdays as number[]).includes(weekdayOf(date));
}

export function nextOccurrence(recurrence: Recurrence, from: LocalDate): LocalDate | null {
  let date = from < recurrence.from ? recurrence.from : from;
  for (let step = 0; step < 7; step += 1, date = addDays(date, 1)) {
    if (recurrence.until !== null && date > recurrence.until) return null;
    if (occursOn(recurrence, date)) return date;
  }
  return null;
}
