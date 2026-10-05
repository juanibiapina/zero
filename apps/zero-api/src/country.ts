const INVALID_COUNTRIES = new Set(["XX", "T1"]);

export const isValidCountry = (value: string): boolean =>
  /^[A-Z]{2}$/.test(value) && !INVALID_COUNTRIES.has(value);

const normalizeCountry = (value?: string): string | null => {
  if (value === undefined) return null;
  const normalized = value.toUpperCase();
  return isValidCountry(normalized) ? normalized : null;
};

// English country names for alpha-2 codes, built once: constructing an
// Intl.DisplayNames per call is pure waste, and a runtime without region data
// leaves this null so every lookup degrades to "no name" instead of throwing.
const regionNames: Intl.DisplayNames | null = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

// The English name for an alpha-2 country code, or null when it cannot be
// resolved. ICU reports a well-formed but unassigned code by echoing the code
// back ("QQ"), and reserved ranges as "Unknown Region"; neither is a name.
export const countryLabel = (code: string): string | null => {
  if (regionNames === null) return null;
  let name: string | undefined;
  try {
    name = regionNames.of(code);
  } catch {
    return null;
  }
  if (name === undefined || name === code || name.includes("Unknown")) {
    return null;
  }
  return name;
};

export const resolveCountry = (
  cfCountry?: string,
  localeRegion?: string,
): string | null =>
  normalizeCountry(cfCountry) ?? normalizeCountry(localeRegion);
