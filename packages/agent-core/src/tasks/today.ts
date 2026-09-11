// The user's local calendar day as YYYY-MM-DD. Both clients mint a new task's
// showUpDate with this and gate the Home / Upcoming split with it, so "today" is
// the device's local day (the server stores the string verbatim and has no
// timezone). Pass a fixed `now` in tests.
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
