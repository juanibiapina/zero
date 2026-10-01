import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveQuery } from '@tanstack/react-db';
import { createTaskdoReplica, localToday, type TaskdoReplica } from '@zero/agent-core';
import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { createMergeableStore } from 'tinybase';

import { useTaskDetail } from '../task-detail';

function Editor({ replica }: { replica: TaskdoReplica }) {
  const { data: tasks = [] } = useLiveQuery((q) => q.from({ t: replica.tasks.collection }));
  const [error, setError] = useState<string | null>(null);
  const detail = useTaskDetail({ replica, projects: [], openTasks: tasks, conditions: [], onAddWaiting: () => {}, onError: setError, waitForPersist: true });
  return <>
    <Pressable accessibilityLabel="Open editor" onPress={() => detail.open(tasks[0])}><Text>Open editor</Text></Pressable>
    {error ? <Text>{error}</Text> : null}
    {detail.sheets}
  </>;
}

describe('Task editing persistence', () => {
  it('keeps a failed scheduled edit open and retries persistence before closing', async () => {
    const queryClient = new QueryClient();
    const store = createMergeableStore();
    store.setRow('tasks', 't', { text: 'Water plants', createdAt: '2026-10-01T12:00:00Z' });
    let saves = 0;
    const replica = createTaskdoReplica({ store, queryClient, queryKeyScope: ['edit-failure'], save: async () => { if (++saves === 1) throw new Error('Disk unavailable'); } });
    await replica.tasks.collection.preload();
    const view = await render(<QueryClientProvider client={queryClient}><Editor replica={replica} /></QueryClientProvider>);
    try {
      await fireEvent.press(view.getByLabelText('Open editor'));
      const input = view.getByDisplayValue('Water plants');
      await fireEvent.changeText(input, 'Water plants every day');
      await fireEvent(input, 'submitEditing');
      await waitFor(() => expect(view.getByText('Disk unavailable')).toBeTruthy());
      expect(view.getByDisplayValue('Water plants')).toBeTruthy();
      await fireEvent(view.getByDisplayValue('Water plants'), 'submitEditing');
      await waitFor(() => expect(view.queryByLabelText('Task text')).toBeNull());
      expect(saves).toBe(2);
      expect(replica.snapshot().tasks[0]).toMatchObject({ text: 'Water plants', recurrenceDate: localToday(), recurrence: { pattern: { unit: 'day' } } });
    } finally {
      view.unmount();
      await replica.close();
      queryClient.clear();
    }
  });
});
