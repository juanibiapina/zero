import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Project, Task, WaitingCondition } from '@zero/agent-core';
import { resetProjectsApiForTest } from '@/lib/projects-collection';
import { resetTasksApiForTest } from '@/lib/tasks-collection';
import { resetWaitsApiForTest } from '@/lib/waits-collection';

import { HomeAppIconSync } from '../home-app-icon-sync';

const mockGetToken = jest.fn<() => Promise<string | null>>();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

const mockSetAppIcon = jest.fn<(icon: string) => boolean>();
jest.mock('../../../modules/home-app-icon', () => ({
  setHomeAppIcon: (icon: string) => mockSetAppIcon(icon),
}));

const mockFetchTasks = jest.fn<() => Promise<Task[]>>();
const mockFetchProjects = jest.fn<() => Promise<Project[]>>();
const mockFetchWaits = jest.fn<() => Promise<WaitingCondition[]>>();
jest.mock('@/lib/api', () => ({
  fetchTasks: () => mockFetchTasks(),
  addTask: () => Promise.reject(new Error('not used')),
  completeTask: () => Promise.reject(new Error('not used')),
  reopenTask: () => Promise.reject(new Error('not used')),
  editTask: () => Promise.reject(new Error('not used')),
  rescheduleTask: () => Promise.reject(new Error('not used')),
  reorderTask: () => Promise.reject(new Error('not used')),
  setTaskProject: () => Promise.reject(new Error('not used')),
  fetchProjects: () => mockFetchProjects(),
  addProject: () => Promise.reject(new Error('not used')),
  setProjectState: () => Promise.reject(new Error('not used')),
  editProject: () => Promise.reject(new Error('not used')),
  deleteProject: () => Promise.reject(new Error('not used')),
  fetchWaits: () => mockFetchWaits(),
  addWaitingCondition: () => Promise.reject(new Error('not used')),
  resolveWaitingCondition: () => Promise.reject(new Error('not used')),
  deleteWaitingCondition: () => Promise.reject(new Error('not used')),
}));

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  text: `Task ${id}`,
  showUpDate: null,
  createdAt: '2026-09-14T07:00:00.000Z',
  completedAt: null,
  projectId: null,
  sortKey: null,
  ...over,
});

function renderSync() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <HomeAppIconSync />
    </QueryClientProvider>,
  );
}

describe('HomeAppIconSync', () => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    resetTasksApiForTest();
    resetProjectsApiForTest();
    resetWaitsApiForTest();
    mockGetToken.mockReset();
    mockGetToken.mockResolvedValue('token');
    mockSetAppIcon.mockReset();
    mockSetAppIcon.mockReturnValue(true);
    mockFetchProjects.mockReset();
    mockFetchProjects.mockResolvedValue([
      {
        id: 'next',
        title: 'Next project',
        icon: '📁',
        description: null,
        state: 'in-play',
        createdAt: '2026-09-14T06:00:00.000Z',
      },
      {
        id: 'backlog',
        title: 'Backlog project',
        icon: '📁',
        description: null,
        state: 'backlog',
        createdAt: '2026-09-14T06:00:00.000Z',
      },
    ]);
    mockFetchWaits.mockReset();
    mockFetchWaits.mockResolvedValue([]);
  });

  it('waits for hydration and then counts only tasks Home shows', async () => {
    let resolveTasks!: (tasks: Task[]) => void;
    mockFetchTasks.mockReset();
    mockFetchTasks.mockReturnValue(
      new Promise<Task[]>((resolve) => {
        resolveTasks = resolve;
      }),
    );

    await renderSync();
    await waitFor(() => expect(mockFetchTasks).toHaveBeenCalled());
    expect(mockSetAppIcon).not.toHaveBeenCalled();

    await act(async () =>
      resolveTasks([
        task('visible'),
        task('complete', { completedAt: '2026-09-14T07:30:00.000Z' }),
        task('future', { showUpDate: '9999-12-31' }),
        task('groomed', { projectId: 'next' }),
        task('backlog', {
          projectId: 'backlog',
          showUpDate: '2026-09-14',
        }),
      ]),
    );

    await waitFor(() =>
      expect(mockSetAppIcon).toHaveBeenCalledWith('OneTask'),
    );
  });
});
