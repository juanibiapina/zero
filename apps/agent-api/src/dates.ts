// Server-side date helpers. Kept standalone (not buried in a store or DO) so they
// are unit-tested in isolation and reused wherever the DO needs the user's local
// calendar day.

// The user's local calendar day as YYYY-MM-DD, for the given IANA timezone. Uses
// the same Intl/en-CA approach as agents/interface.ts formatTimestamp: en-CA
// formats a date as YYYY-MM-DD, and timeZone shifts it to the user's day. The
// authoritative server-side "today" for a timezone, independent of any device
// clock.
export function localDayInZone(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
