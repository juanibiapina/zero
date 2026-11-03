import type { Prompt, TaskdoReplica } from '@zero/agent-core';
import { useCallback, useSyncExternalStore } from 'react';

import { useTodoReplica } from '@/lib/todo-replica-hook';

export function usePrompts(): { replica: TaskdoReplica | null; prompts: Prompt[] | null } {
  const replica = useTodoReplica();
  const prompts = useSyncExternalStore(
    useCallback((listener: () => void) => replica?.subscribe(() => listener()) ?? (() => {}), [replica]),
    useCallback(() => replica?.snapshot().prompts ?? null, [replica]),
  );
  return { replica, prompts };
}
