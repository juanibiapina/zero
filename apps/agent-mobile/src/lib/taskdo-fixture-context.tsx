import { createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useTaskDOFixtureTasks } from './taskdo-tasks-api';

type Fixture = ReturnType<typeof useTaskDOFixtureTasks>;
const FixtureContext = createContext<Fixture | null>(null);

export function TaskDOFixtureProvider({ children }: { children: ReactNode }) {
  const fixture = useTaskDOFixtureTasks();
  // Do not render an empty fixture as an empty account while the local file is
  // opening or failed. All signed-in screens share this single ready gate.
  if (!fixture.ready) return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant={fixture.error ? 'error' : 'subtitle'}>
        {fixture.error ?? 'Opening your saved tasks…'}
      </Text>
    </View>
  );
  return <FixtureContext.Provider value={fixture}>{children}</FixtureContext.Provider>;
}

export function useTaskDOFixtureContext() {
  return useContext(FixtureContext);
}
