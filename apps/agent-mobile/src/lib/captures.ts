import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addCapture,
  fetchInbox,
  processCapture,
  type Capture,
  type TokenGetter,
} from './api';

export const inboxKey = ['inbox'] as const;

// The caller's Inbox (open captures). Retry/backoff, refetch-on-reconnect and
// refetch-on-focus come from the QueryClient defaults + AppState bridge.
export function useInbox(getToken: TokenGetter) {
  return useQuery({
    queryKey: inboxKey,
    queryFn: () => fetchInbox(getToken),
  });
}

// Capture a new item. Not optimistic: on success the server row (with its id) is
// appended to the cached Inbox.
export function useAddCapture(getToken: TokenGetter) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => addCapture(getToken, text),
    onSuccess: (capture) => {
      queryClient.setQueryData<Capture[]>(inboxKey, (old = []) => [
        ...old,
        capture,
      ]);
    },
  });
}

// Process a capture (GTD Clarify). Optimistic: drop it from the cached Inbox
// immediately and restore it if the request fails.
export function useProcessCapture(getToken: TokenGetter) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => processCapture(getToken, id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: inboxKey });
      const previous = queryClient.getQueryData<Capture[]>(inboxKey);
      queryClient.setQueryData<Capture[]>(inboxKey, (old = []) =>
        old.filter((capture) => capture.id !== id),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(inboxKey, context.previous);
      }
    },
  });
}
