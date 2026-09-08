// The web surface's AI icon-suggestion cache: a tiny store keyed by project id,
// persisted in localStorage so it survives reloads and is there when the picker
// opens. It is NOT an entity collection — no sync, no outbox, no server row,
// just a device-local hint. The pure staleness check and the shared shape live
// in @zero/agent-core; the fetch and this persistence are per surface.

import { useSyncExternalStore } from "react";
import type {
  CachedIconSuggestions,
  IconSuggestionBasis,
} from "@zero/agent-core";
import { fetchIconSuggestions } from "./projects";

const STORAGE_KEY = "zero.icon-suggestions.v1";

type Store = Record<string, CachedIconSuggestions>;

const load = (): Store => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
};

let cache: Store = load();
const subscribers = new Set<() => void>();
const inFlight = new Set<string>();

const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // A full or unavailable localStorage only costs the persistence, not the
    // in-memory hint; ignore.
  }
};

const set = (id: string, entry: CachedIconSuggestions) => {
  cache = { ...cache, [id]: entry };
  persist();
  for (const cb of subscribers) cb();
};

export const getIconSuggestions = (
  id: string,
): CachedIconSuggestions | undefined => cache[id];

const subscribe = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};

// Fire a suggestion request for a project and cache the result. Shared by the
// create-time pre-warm and the picker's fetch-on-open (both no-op when an entry
// already exists) and by Refresh (`force`, which always re-fires). Never throws:
// a failed request lands as `status: "error"` so the manual picker still stands.
export const requestIconSuggestions = async (
  id: string,
  basis: IconSuggestionBasis,
  opts: { force?: boolean } = {},
): Promise<void> => {
  if (inFlight.has(id)) return;
  if (!opts.force && cache[id]) return;
  inFlight.add(id);
  set(id, { icons: cache[id]?.icons ?? [], basis, status: "loading" });
  try {
    const icons = await fetchIconSuggestions(basis);
    set(id, { icons, basis, status: "ready" });
  } catch {
    set(id, { icons: [], basis, status: "error" });
  } finally {
    inFlight.delete(id);
  }
};

// Subscribe a component to one project's cached suggestions.
export const useIconSuggestions = (
  id: string,
): CachedIconSuggestions | undefined =>
  useSyncExternalStore(
    subscribe,
    () => getIconSuggestions(id),
    () => getIconSuggestions(id),
  );

// Test seam: drop the in-memory and persisted cache between tests.
export const __resetIconSuggestions = () => {
  cache = {};
  inFlight.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};
