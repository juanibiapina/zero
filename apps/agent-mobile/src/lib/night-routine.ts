import { nightView, type NightView, type TaskdoReplica } from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { useTodoReplica } from '@/lib/todo-replica-hook';

export function useNightRoutine(): { replica: TaskdoReplica | null; view: NightView | null } {
  const replica = useTodoReplica();
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => replica?.subscribe(() => listener()) ?? (() => {}), [replica]),
    useCallback(() => replica?.snapshot(), [replica]),
  );
  const [tick, setTick] = useState(0);
  const view = useMemo(
    () => (snapshot ? nightView(snapshot.nights, new Date()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, tick],
  );
  const nextChange = view?.nextChange.getTime() ?? null;

  useEffect(() => {
    if (nextChange == null) return;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(1, nextChange - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [nextChange]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setTick((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  return { replica, view };
}
