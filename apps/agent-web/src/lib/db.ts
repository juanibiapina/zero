import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from "@tanstack/browser-db-sqlite-persistence";

const DATABASE_NAME = "zero-app.sqlite";

type AppPersistence = ReturnType<typeof createBrowserWASQLitePersistence>;

let persistencePromise: Promise<AppPersistence> | null = null;

// Open the OPFS handle once per tab AND build the persistence object once,
// sharing that one object across every collection. One persistence object means
// one driver with one serialization queue, so concurrent transactions from
// different collections never interleave into a nested `BEGIN IMMEDIATE`.
// Calling `createBrowserWASQLitePersistence` per collection would build a fresh
// queue over the same single OPFS connection and corrupt transactions.
export function getAppPersistence(): Promise<AppPersistence> {
  if (!persistencePromise) {
    persistencePromise = openBrowserWASQLiteOPFSDatabase({
      databaseName: DATABASE_NAME,
    }).then((database) => createBrowserWASQLitePersistence({ database }));
  }
  return persistencePromise;
}
