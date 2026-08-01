const INVALID_COUNTRIES = new Set(["XX", "T1"]);

export const isValidCountry = (value: string): boolean =>
  /^[A-Z]{2}$/.test(value) && !INVALID_COUNTRIES.has(value);

const normalizeCountry = (value?: string): string | null => {
  if (value === undefined) return null;
  const normalized = value.toUpperCase();
  return isValidCountry(normalized) ? normalized : null;
};

export const resolveCountry = (
  cfCountry?: string,
  localeRegion?: string,
): string | null =>
  normalizeCountry(cfCountry) ?? normalizeCountry(localeRegion);
