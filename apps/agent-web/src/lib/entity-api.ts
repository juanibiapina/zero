import { QueryClient } from "@tanstack/react-query";
import { startOfflineExecutor } from "@tanstack/offline-transactions";
import type { EntityApiDeps } from "@zero/agent-core";

import { getAppPersistence } from "./db";

// The one QueryClient every in-memory (fallback) collection reads through.
export const queryClient = new QueryClient();

// The deps every web entity data layer passes to its shared factory: the OPFS
// persistence (opened once per tab, see ./db) and the browser offline outbox.
// Web auth is the same-origin cookie, so each entity's REST closures carry no
// token.
function webDeps(): EntityApiDeps {
  return {
    queryClient,
    persistence: () => getAppPersistence(),
    startOfflineExecutor,
    onWarn: (message, error) => console.warn(message, error),
  };
}

// One web entity data layer as a per-tab singleton: the OPFS database and outbox
// are opened once, and the shared factory falls back to the in-memory Query
// Collection if durable persistence cannot start (private browsing, older
// browsers).
export function defineWebEntityApi<Api>(
  create: (deps: EntityApiDeps) => Promise<Api>,
): () => Promise<Api> {
  let apiPromise: Promise<Api> | null = null;
  return () => {
    if (!apiPromise) apiPromise = create(webDeps());
    return apiPromise;
  };
}
