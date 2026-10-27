import type { ShoppingItem, TaskdoReplica } from '@zero/agent-core';
import { useCallback, useSyncExternalStore } from 'react';

import { useTodoReplica } from '@/lib/todo-replica-hook';

export function useShoppingList(): { replica: TaskdoReplica | null; items: ShoppingItem[] | null } {
  const replica = useTodoReplica();
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => replica?.subscribe(() => listener()) ?? (() => {}), [replica]),
    useCallback(() => replica?.snapshot(), [replica]),
  );
  return { replica, items: snapshot?.shopping ?? null };
}
