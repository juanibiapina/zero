import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addTodo,
  fetchTodos,
  markTodoDone,
  type Todo,
  type TokenGetter,
} from './api';

export const todosKey = ['todos'] as const;

// The caller's open todo list. Retry/backoff, refetch-on-reconnect and
// refetch-on-focus come from the QueryClient defaults + AppState bridge.
export function useTodos(getToken: TokenGetter) {
  return useQuery({
    queryKey: todosKey,
    queryFn: () => fetchTodos(getToken),
  });
}

// Capture a new todo. Not optimistic: on success the server row (with its id) is
// appended to the cached list.
export function useAddTodo(getToken: TokenGetter) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => addTodo(getToken, text),
    onSuccess: (todo) => {
      queryClient.setQueryData<Todo[]>(todosKey, (old = []) => [...old, todo]);
    },
  });
}

// Mark a todo done. Optimistic: drop it from the cached list immediately and
// restore it if the request fails.
export function useMarkTodoDone(getToken: TokenGetter) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => markTodoDone(getToken, id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: todosKey });
      const previous = queryClient.getQueryData<Todo[]>(todosKey);
      queryClient.setQueryData<Todo[]>(todosKey, (old = []) =>
        old.filter((todo) => todo.id !== id),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(todosKey, context.previous);
      }
    },
  });
}
