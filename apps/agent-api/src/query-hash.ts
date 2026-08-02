// Stable, non-reversible digest of a search query, so log lines can group and
// count repeats WITHOUT carrying query text. `log.ts` forbids message content in
// fields and a query is derived from the user's message, so this is what stands
// in for it (same reasoning as read-page.ts, which logs no address).
//
// FNV-1a, 32-bit, rendered as 8 hex chars. Chosen because it is synchronous:
// `crypto.subtle.digest` is async and would push an await into every log site
// for no benefit. Collisions are irrelevant here — the digest groups requests,
// it does not identify them.

export const queryHash = (query: string): string => {
  let hash = 0x811c9dc5;
  const normalized = query.trim().toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    // FNV prime 16777619, via shifts to stay in 32-bit integer math.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
