import { useAuth } from '@clerk/expo';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { EntityApiDeps, StartOfflineExecutor } from '@zero/agent-core';
import { useEffect, useState } from 'react';

import type { TokenGetter } from './api';
import { getAppOutbox, getAppPersistence } from './db';

type EntityCollectionApi = { collection: { cleanup: () => Promise<void> } };

// Test-only REST collection harness bound to the current Clerk token.
//
// - **Singleton, never cleaned up.** Building a second collection over the same
//   op-sqlite table would run two sync loops on one table and corrupt writes, so
//   every screen reads the one instance; it lives for the app's lifetime, like
//   the web singleton.
// - **Token ref.** The singleton is built once yet must always call Clerk's
//   latest `getToken` (its function identity changes across renders), so the
//   getter lives in a module ref the hook updates on every render.
// - **Durable offline SQLite (op-sqlite) + the shared outbox** that retries over
//   the native network detector, through the single app database and outbox.
//   `@tanstack/offline-transactions/react-native` is imported lazily inside the
//   persistence thunk, and its `startOfflineExecutor` is stashed for the
//   synchronous call the shared factory makes right after (only on the durable
//   path). When the native modules are unavailable (e.g. under jest) the thunk
//   throws and the shared factory falls back to its in-memory Query Collection,
//   so tests need no op-sqlite mock.
export function defineMobileEntityApi<Api extends EntityCollectionApi, Rest>(opts: {
  // One of the shared `@zero/agent-core` entity factories (createCapturesApi, …).
  create: (deps: EntityApiDeps & { rest: Rest }) => Promise<Api>;
  // Bind the entity's cross-origin REST helpers to a token getter, so the shared
  // factory stays auth-agnostic.
  makeRest: (getToken: TokenGetter) => Rest;
}): {
  // The singleton, built on first call.
  get: (queryClient: QueryClient) => Promise<Api>;
  // Drop the singleton so the next `get` builds a fresh collection. For tests
  // only: the module-level singleton otherwise leaks rows across renders.
  resetForTest: () => void;
  // Read the singleton inside the signed-in tree, where the Clerk token getter
  // is valid. Keeps the token ref pointed at Clerk's latest getToken and returns
  // the api once it resolves.
  useApi: () => Api | null;
} {
  let tokenGetter: TokenGetter = async () => null;
  let apiPromise: Promise<Api> | null = null;

  const create = (deps: { queryClient: QueryClient; getToken: TokenGetter }) => {
    let startExecutor: StartOfflineExecutor | null = null;
    return opts.create({
      queryClient: deps.queryClient,
      rest: opts.makeRest(deps.getToken),
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
  };

  const get = (queryClient: QueryClient) => {
    if (!apiPromise) {
      apiPromise = create({ queryClient, getToken: () => tokenGetter() });
    }
    return apiPromise;
  };

  const useApi = (): Api | null => {
    const queryClient = useQueryClient();
    const { getToken } = useAuth();
    tokenGetter = getToken;

    const [api, setApi] = useState<Api | null>(null);
    useEffect(() => {
      let live = true;
      void get(queryClient).then((a) => {
        if (live) setApi(a);
      });
      return () => {
        live = false;
      };
    }, [queryClient]);

    return api;
  };

  return {
    get,
    resetForTest: () => {
      const pending = apiPromise;
      apiPromise = null;
      if (pending) void pending.then((a) => a.collection.cleanup()).catch(() => {});
    },
    useApi,
  };
}
