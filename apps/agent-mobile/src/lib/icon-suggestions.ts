// The mobile surface's AI icon-suggestion cache: a tiny store keyed by project
// id, persisted in AsyncStorage so it survives reloads and is there when the
// picker opens. It is NOT an entity collection — no sync, no outbox, no server
// row, just a device-local hint. The pure staleness check and the shared shape
// live in @zero/agent-core; the fetch (Clerk Bearer) and this persistence are
// per surface. Sibling of the web store in apps/agent-web/src/lib/icon-suggestions.ts.

import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  CachedIconSuggestions,
  IconSuggestionBasis,
} from '@zero/agent-core';

import { fetchIconSuggestions, type TokenGetter } from './api';

const STORAGE_KEY = 'zero.icon-suggestions.v1';

type Store = Record<string, CachedIconSuggestions>;

let cache: Store = {};
const subscribers = new Set<() => void>();
const inFlight = new Set<string>();
let hydrated = false;

const emit = () => {
  for (const cb of subscribers) cb();
};

// AsyncStorage is async, so the cache hydrates after the first render. Entries
// written before hydration finishes (a create-time warm at cold start) win over
// the stored copy, so an in-flight request is never clobbered by a stale disk read.
const hydrate = async () => {
  if (hydrated) return;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) cache = { ...(JSON.parse(raw) as Store), ...cache };
  } catch {
    // A corrupt or unavailable store just starts empty.
  }
  hydrated = true;
  emit();
};
void hydrate();

const persist = () => {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache)).catch(() => {
    // A failed write only costs the persistence, not the in-memory hint.
  });
};

const set = (id: string, entry: CachedIconSuggestions) => {
  cache = { ...cache, [id]: entry };
  persist();
  emit();
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
  getToken: TokenGetter,
  id: string,
  basis: IconSuggestionBasis,
  opts: { force?: boolean } = {},
): Promise<void> => {
  if (inFlight.has(id)) return;
  if (!opts.force && cache[id]) return;
  inFlight.add(id);
  set(id, { icons: cache[id]?.icons ?? [], basis, status: 'loading' });
  try {
    const icons = await fetchIconSuggestions(getToken, basis);
    set(id, { icons, basis, status: 'ready' });
  } catch {
    set(id, { icons: [], basis, status: 'error' });
  } finally {
    inFlight.delete(id);
  }
};

// Subscribe a component to one project's cached suggestions.
export const useIconSuggestions = (
  id: string,
): CachedIconSuggestions | undefined =>
  useSyncExternalStore(subscribe, () => getIconSuggestions(id));

// Test seam: drop the in-memory and persisted cache between tests.
export const __resetIconSuggestions = () => {
  cache = {};
  inFlight.clear();
  hydrated = true;
  void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
};
