import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addCapture,
  fetchInbox,
  processCapture,
  type Capture,
  type TokenGetter,
} from './api';

export const inboxKey = ['inbox'] as const;

export function useInbox(getToken: TokenGetter) {
  return useQuery({
    queryKey: inboxKey,
    queryFn: () => fetchInbox(getToken),
  });
}

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

// Optimistic: drop it from the cached Inbox immediately, restore on failure.
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
