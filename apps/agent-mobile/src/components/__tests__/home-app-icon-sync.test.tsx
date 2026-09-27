import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { Project, Task } from '@zero/agent-core';

import {
  createInMemoryTodoData,
  InMemoryTodoDataProvider,
  type InMemoryTodoSeed,
} from '@/testing/in-memory-todo-data';

import { HomeAppIconSync } from '../home-app-icon-sync';

const mockSetAppIcon = jest.fn<(icon: string) => boolean>();
jest.mock('../../../modules/home-app-icon', () => ({
  setHomeAppIcon: (icon: string) => mockSetAppIcon(icon),
}));

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  text: `Task ${id}`,
  showUpDate: null,
  recurrence: null,
  recurrenceDate: null,
  createdAt: '2026-09-14T07:00:00.000Z',
  completedAt: null,
  projectId: null,
  sortKey: null,
  ...over,
});
const project = (id: string, state: Project['state']): Project => ({
  id,
  title: `${state} project`,
  icon: '📁',
  description: null,
  state,
  createdAt: '2026-09-14T06:00:00.000Z',
});

function renderSync(seed: InMemoryTodoSeed = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InMemoryTodoDataProvider data={createInMemoryTodoData(seed)}>
        <HomeAppIconSync />
      </InMemoryTodoDataProvider>
    </QueryClientProvider>,
  );
}

describe('HomeAppIconSync', () => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockSetAppIcon.mockReset();
    mockSetAppIcon.mockReturnValue(true);
  });

  it('selects the Empty alias for an empty Home', async () => {
    renderSync();
    await waitFor(() => expect(mockSetAppIcon).toHaveBeenCalledWith('Empty'));
  });

  it('counts only tasks visible on Home', async () => {
    renderSync({
      projects: [project('next', 'in-play'), project('backlog', 'backlog')],
      tasks: [
        task('visible'),
        task('complete', { completedAt: '2026-09-14T07:30:00.000Z' }),
        task('future', { showUpDate: '9999-12-31' }),
        task('groomed', { projectId: 'next' }),
        task('backlog', { projectId: 'backlog', showUpDate: '2026-09-14' }),
      ],
    });
    await waitFor(() => expect(mockSetAppIcon).toHaveBeenCalledWith('OneTask'));
  });
});
