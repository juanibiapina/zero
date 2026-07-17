// Timezone helpers built on the runtime's IANA database (ECMA-402
// `Intl.supportedValuesOf`). We store the canonical IANA name (e.g.
// "Europe/Berlin"), never a fixed offset, so DST is resolved automatically
// whenever an instant is formatted in that zone.

// Fallback used before any zone is known (a user who has never opened the web
// app). Rare given the app sets the zone on first mount; UTC keeps the anchor
// honest rather than guessing.
export const DEFAULT_TIMEZONE = "UTC";

const zones = (): string[] => Intl.supportedValuesOf("timeZone");

// True for a canonical IANA zone (a member of the runtime's list) or "UTC"
// (which `supportedValuesOf` omits). Deliberately rejects legacy abbreviations
// like "PST": those carry a fixed offset and ignore DST, so storing one would
// silently break half the year. The browser and model both emit canonical
// `Area/Location` names, so this is the right contract.
export const isValidTimezone = (tz: string): boolean =>
  tz === "UTC" || zones().includes(tz);

// Near matches for a rejected input, so the model can correct itself. Matches
// on any substring of the full name, case-insensitive, and also on the city
// segment with spaces normalized to underscores ("new york" -> the
// "America/New_York" entry).
export const suggestTimezones = (query: string, limit = 5): string[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const normalized = q.replace(/\s+/g, "_");
  return zones()
    .filter((z) => {
      const lower = z.toLowerCase();
      return lower.includes(q) || lower.includes(normalized);
    })
    .slice(0, limit);
};
