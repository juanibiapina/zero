import type { QueryClient } from '@tanstack/react-query';
import {
  createCapturesApi,
  type CapturesApi,
  type CapturesRest,
  type StartOfflineExecutor,
} from '@zero/agent-core';

import {
  addCapture,
  editCapture,
  fetchCaptures,
  processCapture,
  reorderCapture,
  rescheduleCapture,
  type TokenGetter,
} from './api';
import { getAppOutbox, getAppPersistence } from './db';

// The current Clerk token getter, kept in a module ref so the singleton api is
// built once yet always calls Clerk's latest getToken. The hook updates this on
// every render (see use-captures-api).
let tokenGetter: TokenGetter = async () => null;

export function setCapturesTokenGetter(getToken: TokenGetter): void {
  tokenGetter = getToken;
}

let apiPromise: Promise<CapturesApi> | null = null;

// Singleton Capture data layer, shared across every tab. Building a second
// collection over the same op-sqlite file would run two sync loops on one table
// and corrupt writes, so both the Captures and Upcoming screens read this one
// instance. Never cleaned up: it lives for the app's lifetime, like the web
// singleton.
export function getMobileCapturesApi(
  queryClient: QueryClient,
): Promise<CapturesApi> {
  if (!apiPromise) {
    apiPromise = createMobileCapturesApi({
      queryClient,
      getToken: () => tokenGetter(),
    });
  }
  return apiPromise;
}

// Drop the singleton so the next getMobileCapturesApi builds a fresh collection.
// For tests only: the module-level singleton otherwise leaks rows across renders
// and breaks isolation.
export function resetCapturesApiForTest(): void {
  const pending = apiPromise;
  apiPromise = null;
  if (pending) void pending.then((a) => a.collection.cleanup()).catch(() => {});
}

// Bind the cross-origin REST helpers to the current Clerk token getter so the
// shared factory stays auth-agnostic.
function makeRest(getToken: TokenGetter): CapturesRest {
  return {
    fetchCaptures: () => fetchCaptures(getToken),
    addCapture: (capture) => addCapture(getToken, capture),
    processCapture: (id) => processCapture(getToken, id),
    editCapture: (id, text) => editCapture(getToken, id, text),
    rescheduleCapture: (id, showUpDate) =>
      rescheduleCapture(getToken, id, showUpDate),
    reorderCapture: (id, sortKey) => reorderCapture(getToken, id, sortKey),
  };
}

// Build the mobile Capture data layer: durable offline SQLite (op-sqlite) plus an
// outbox that retries over the native network detector, both shared with every
// other collection through the single app database and outbox. Falls back to the
// shared in-memory Query Collection when the native modules are unavailable (e.g.
// under jest), so tests need no op-sqlite mock.
export function createMobileCapturesApi(deps: {
  queryClient: QueryClient;
  getToken: TokenGetter;
}): Promise<CapturesApi> {
  // Stashed during the async persistence step, then used by the synchronous
  // startOfflineExecutor the shared factory calls (only on the durable path).
  let startExecutor: StartOfflineExecutor | null = null;

  return createCapturesApi({
    queryClient: deps.queryClient,
    rest: makeRest(deps.getToken),
    persistence: async () => {
      const rn = await import('@tanstack/offline-transactions/react-native');
      const { storage, onlineDetector } = await getAppOutbox();
      startExecutor = (config) =>
        rn.startOfflineExecutor({ ...config, storage, onlineDetector });
      return getAppPersistence();
    },
    startOfflineExecutor: (config) => {
      if (!startExecutor) {
        throw new Error('offline executor not initialized before use');
      }
      return startExecutor(config);
    },
    onWarn: (message, error) => console.warn(message, error),
  });
}
