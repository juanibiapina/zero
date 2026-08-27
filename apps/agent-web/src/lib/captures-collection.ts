import { createCollection, type Collection, type Transaction } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { QueryClient } from "@tanstack/react-query";
import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { startOfflineExecutor } from "@tanstack/offline-transactions";

import { addCapture, fetchInbox, processCapture, type Capture } from "./captures";

export const queryClient = new QueryClient();

const DATABASE_NAME = "zero-inbox.sqlite";
// Bumping this clears the persisted local copy and re-syncs from the server.
const SCHEMA_VERSION = 1;
const CAPTURES_QUERY_KEY = ["captures"];

// One handle over the Inbox data layer, so the page does not care whether it is
// backed by durable offline SQLite or the in-memory fallback.
export type CapturesApi = {
  collection: Collection<Capture, string>;
  // Both return the underlying transaction so the page can surface a write error.
  add: (text: string) => Transaction;
  process: (id: string) => Transaction;
  // True when writes persist to a durable offline outbox (SQLite + IndexedDB).
  offline: boolean;
};

function newTempId(): string {
  return `temp-${crypto.randomUUID()}`;
}

function optimisticCapture(text: string): Capture {
  return { id: newTempId(), text, createdAt: new Date().toISOString(), processedAt: null };
}

function markProcessed(draft: Capture): void {
  draft.processedAt = new Date().toISOString();
}

// Fallback: the Phase 1 in-memory Query Collection with server-calling handlers.
// Used when OPFS/Worker is unavailable (private browsing, older browsers) so the
// Inbox never hard-crashes; offline writes are not durable in this mode.
function createInMemoryApi(): CapturesApi {
  const collection = createCollection(
    queryCollectionOptions({
      queryClient,
      queryKey: CAPTURES_QUERY_KEY,
      queryFn: () => fetchInbox(),
      getKey: (c: Capture) => c.id,
      onInsert: async ({ transaction }) => {
        for (const m of transaction.mutations) await addCapture(m.modified.text);
      },
      onUpdate: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          if (m.modified.processedAt != null) await processCapture(String(m.key));
        }
      },
    }),
  );

  return {
    collection,
    add: (text) => collection.insert(optimisticCapture(text)),
    process: (id) => collection.update(id, markProcessed),
    offline: false,
  };
}

// Durable offline mode: the synced Query Collection is persisted to SQLite/OPFS
// for offline reads, and writes go through an IndexedDB-backed outbox that
// retries when the network returns. The collection carries NO server-calling
// handlers: every write flows through the executor's mutationFns below, which
// call the REST API and then refetch to reconcile the optimistic temp-id row
// with the server's real row (mirroring the Query Collection's own auto-refetch).
async function createPersistedApi(): Promise<CapturesApi> {
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: DATABASE_NAME });
  const persistence = createBrowserWASQLitePersistence({ database });

  const collection = createCollection(
    persistedCollectionOptions<Capture, string>({
      persistence,
      schemaVersion: SCHEMA_VERSION,
      ...queryCollectionOptions({
        queryClient,
        queryKey: CAPTURES_QUERY_KEY,
        queryFn: () => fetchInbox(),
        getKey: (c: Capture) => c.id,
      }),
    }),
  );

  const offline = startOfflineExecutor({
    collections: { captures: collection },
    mutationFns: {
      addCapture: async ({ transaction }) => {
        // The outbox types a mutation's fields as unknown; narrow before sending.
        for (const m of transaction.mutations) {
          const text = m.modified.text;
          if (typeof text === "string") await addCapture(text);
        }
        await queryClient.invalidateQueries({ queryKey: CAPTURES_QUERY_KEY });
      },
      processCapture: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          if (m.modified.processedAt != null) await processCapture(String(m.key));
        }
        await queryClient.invalidateQueries({ queryKey: CAPTURES_QUERY_KEY });
      },
    },
    onLeadershipChange: (isLeader) => {
      // Non-leader tabs run online-only; acceptable for a single-user Inbox.
      if (!isLeader) {
        console.warn("inbox: another tab holds the offline outbox; this tab is online-only");
      }
    },
  });

  const addAction = offline.createOfflineAction<{ text: string }>({
    mutationFnName: "addCapture",
    onMutate: ({ text }) => {
      collection.insert(optimisticCapture(text));
    },
  });
  const processAction = offline.createOfflineAction<{ id: string }>({
    mutationFnName: "processCapture",
    onMutate: ({ id }) => {
      collection.update(id, markProcessed);
    },
  });

  return {
    collection,
    add: (text) => addAction({ text }),
    process: (id) => processAction({ id }),
    offline: true,
  };
}

let apiPromise: Promise<CapturesApi> | null = null;

// Singleton: the OPFS database and outbox are opened once per tab. Falls back to
// the in-memory Query Collection if durable persistence cannot start.
export function getCapturesApi(): Promise<CapturesApi> {
  if (!apiPromise) {
    apiPromise = createPersistedApi().catch((err) => {
      console.warn("inbox: offline SQL persistence unavailable, using in-memory fallback", err);
      return createInMemoryApi();
    });
  }
  return apiPromise;
}
