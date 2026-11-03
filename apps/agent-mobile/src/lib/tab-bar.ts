import { useFocusEffect } from 'expo-router';
import { createContext, useCallback, useContext } from 'react';

export const TabBarContext = createContext<(hidden: boolean) => void>(() => {});

export function useHiddenTabBar() {
  const setHidden = useContext(TabBarContext);
  useFocusEffect(useCallback(() => {
    setHidden(true);
    return () => setHidden(false);
  }, [setHidden]));
}
