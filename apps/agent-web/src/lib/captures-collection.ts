import { createCollection } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { QueryClient } from "@tanstack/react-query";

import { addCapture, fetchInbox, processCapture, type Capture } from "./captures";

export const queryClient = new QueryClient();

// Process is modeled as an update that stamps processedAt: the Inbox live query
// filters processedAt == null, so the row leaves the view while the handler
// hits the process endpoint. onInsert only sends text; the server mints the id
// and the auto-refetch replaces the optimistic temp-id row.
export const capturesCollection = createCollection(
  queryCollectionOptions({
    queryClient,
    queryKey: ["captures"],
    queryFn: () => fetchInbox(),
    getKey: (capture: Capture) => capture.id,
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
