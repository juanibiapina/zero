// TanStack DB collection for the Capture Inbox (spike, Phase 1: in-memory Query
// Collection over the existing DO REST API; no offline persistence yet). One
// reactive local store: reads via live queries, writes optimistically, and the
// Query Collection auto-refetches GET /api/captures after each mutation handler
// so the local state reconciles with the server (which mints ids and filters the
// Inbox to open captures). Same-origin cookie auth, same UserDO as mobile.

import { createCollection } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { QueryClient } from "@tanstack/react-query";

import { addCapture, fetchInbox, processCapture, type Capture } from "./captures";

// A dedicated client for the collection's background queries. Kept module-local;
// the collection drives its own observers, so no QueryClientProvider is needed.
export const queryClient = new QueryClient();

export const capturesCollection = createCollection(
  queryCollectionOptions({
    queryClient,
    queryKey: ["captures"],
    // The server returns the open Inbox (processedAt IS NULL), oldest first.
    queryFn: () => fetchInbox(),
    getKey: (capture: Capture) => capture.id,
    // Capture: POST the text; the server mints the id. The optimistic row (with
    // a temp client id) is replaced by the auto-refetch that follows.
    onInsert: async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        await addCapture(mutation.modified.text);
      }
    },
    // Process (GTD Clarify): an update that stamps processedAt. The Inbox live
    // query filters processedAt == null, so the row leaves the view instantly;
    // the handler calls the process endpoint and the refetch confirms removal.
    onUpdate: async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        if (mutation.modified.processedAt != null) {
          await processCapture(String(mutation.key));
        }
      }
    },
  }),
);
