// The shared, platform-agnostic pieces of the AI icon-suggestion feature: the
// cached-hint shape and the pure staleness check. The persistence and the fetch
// live per surface (web/mobile); only this pure logic is shared.

// What the model was asked about. The create-time run knows only the title (the
// description is added later on the detail screen), so `description` is null then.
export type IconSuggestionBasis = {
  title: string;
  description: string | null;
};

export type IconSuggestionStatus = "loading" | "ready" | "error";

// One project's cached suggestions, keyed by project id in a per-surface store.
// Not an entity collection: no sync, no outbox, no server row — just a hint.
export type CachedIconSuggestions = {
  icons: string[];
  basis: IconSuggestionBasis;
  status: IconSuggestionStatus;
};

// Normalize a basis so that trivial differences (surrounding whitespace, null vs
// an empty/whitespace-only description) do not read as a change.
const normalize = (basis: IconSuggestionBasis) => {
  const description = (basis.description ?? "").trim();
  return { title: basis.title.trim(), description };
};

// Whether the cached suggestions were computed from a different title/description
// than the current one — the signal to offer a Refresh. A description added
// after the create-time (title-only) run makes the basis stale.
export const isBasisStale = (
  cached: IconSuggestionBasis,
  current: IconSuggestionBasis,
): boolean => {
  const a = normalize(cached);
  const b = normalize(current);
  return a.title !== b.title || a.description !== b.description;
};
