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
  rescheduleCapture,
  type TokenGetter,
} from './api';
import { getAppOutbox, getAppPersistence } from './db';

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
