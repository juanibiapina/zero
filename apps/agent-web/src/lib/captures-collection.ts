import { QueryClient } from "@tanstack/react-query";
import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from "@tanstack/browser-db-sqlite-persistence";
import { startOfflineExecutor } from "@tanstack/offline-transactions";
import { createCapturesApi, type CapturesApi } from "@zero/agent-core";

import { addCapture, fetchInbox, processCapture } from "./captures";

export type { CapturesApi };

export const queryClient = new QueryClient();

const DATABASE_NAME = "zero-inbox.sqlite";

let apiPromise: Promise<CapturesApi> | null = null;

// Singleton: the OPFS database and outbox are opened once per tab. The shared
// factory falls back to the in-memory Query Collection if durable persistence
// cannot start (private browsing, older browsers). Web auth is the same-origin
// cookie, so the REST closures carry no token.
export function getCapturesApi(): Promise<CapturesApi> {
  if (!apiPromise) {
    apiPromise = createCapturesApi({
      queryClient,
      rest: { fetchInbox, addCapture, processCapture },
      persistence: async () => {
        const database = await openBrowserWASQLiteOPFSDatabase({
          databaseName: DATABASE_NAME,
        });
        return createBrowserWASQLitePersistence({ database });
      },
      startOfflineExecutor,
      onWarn: (message, error) => console.warn(message, error),
    });
  }
  return apiPromise;
}
