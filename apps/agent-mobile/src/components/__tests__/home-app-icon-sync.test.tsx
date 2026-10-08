import { projectParent } from '@zero/agent-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, waitFor } from '@testing-library/react-native';
import type { Project, Task } from '@zero/agent-core';

import type { TodoData } from '@/lib/todo-data-context';
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
  parent: null,
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

let todoData: TodoData;
let renderedSync: Awaited<ReturnType<typeof render>> | undefined;

async function renderSync(seed: InMemoryTodoSeed = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  todoData = createInMemoryTodoData(seed);
  renderedSync = await render(
    <QueryClientProvider client={client}>
      <InMemoryTodoDataProvider data={todoData}>
        <HomeAppIconSync />
      </InMemoryTodoDataProvider>
    </QueryClientProvider>,
  );
  return todoData.replica!;
}

async function expectIcon(icon: string) {
  await waitFor(() => expect(mockSetAppIcon).toHaveBeenLastCalledWith(icon));
}

describe('HomeAppIconSync', () => {
  beforeEach(() => {
    mockSetAppIcon.mockReset();
    mockSetAppIcon.mockReturnValue(true);
  });

  afterEach(async () => {
    await renderedSync?.unmount();
    renderedSync = undefined;
    await todoData?.replica?.close();
    jest.useRealTimers();
  });

  it.each<[number, string]>([
    [0, 'Empty'],
    [1, 'OneTask'],
    [2, 'TwoTasks'],
    [3, 'ThreeTasks'],
    [4, 'FourPlusTasks'],
    [5, 'FourPlusTasks'],
  ])('selects %s visible Home tasks as %s', async (count, icon) => {
    await renderSync({ tasks: Array.from({ length: count }, (_, index) => task(String(index))) });
    await expectIcon(icon);
  });

  it('warns without throwing when Android rejects the icon', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSetAppIcon.mockReturnValue(false);

    await renderSync({ tasks: [task('1')] });

    await waitFor(() => expect(warn).toHaveBeenCalledWith('Could not update the Home task-count launcher icon.'));
    warn.mockRestore();
  });

  it('warns without throwing when the native call throws', async () => {
    const error = new Error('native unavailable');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSetAppIcon.mockImplementation(() => { throw error; });

    await renderSync({ tasks: [task('1')] });

    await waitFor(() => expect(warn).toHaveBeenCalledWith('Could not update the Home task-count launcher icon.', error));
    warn.mockRestore();
  });

  it('counts only tasks visible on Home', async () => {
    await renderSync({
      projects: [project('next', 'in-play'), project('backlog', 'backlog')],
      tasks: [
        task('visible'),
        task('scheduled', { parent: projectParent('next'), showUpDate: '2026-09-14' }),
        task('complete', { completedAt: '2026-09-14T07:30:00.000Z' }),
        task('future', { showUpDate: '9999-12-31' }),
        task('groomed', { parent: projectParent('next') }),
        task('backlog', { parent: projectParent('backlog'), showUpDate: '2026-09-14' }),
      ],
    });
    await expectIcon('TwoTasks');
  });

  it('follows adding, completing, and reopening tasks', async () => {
    const replica = await renderSync();
    await expectIcon('Empty');

    await act(async () => {
      await replica.tasks.add('First task').isPersisted.promise;
    });
    await expectIcon('OneTask');
    const first = replica.snapshot().tasks[0]!;

    await act(async () => {
      await replica.tasks.add('Second task').isPersisted.promise;
    });
    await expectIcon('TwoTasks');
    const second = replica.snapshot().tasks.find((entry) => entry.id !== first.id)!;

    await act(async () => {
      await replica.tasks.complete(first.id).isPersisted.promise;
    });
    await expectIcon('OneTask');
    await act(async () => {
      await replica.tasks.reopen(first).isPersisted.promise;
    });
    await expectIcon('TwoTasks');
    await act(async () => {
      await replica.tasks.complete(first.id).isPersisted.promise;
      await replica.tasks.complete(second.id).isPersisted.promise;
    });
    await expectIcon('Empty');
  });

  it('follows the owning Project entering and leaving play', async () => {
    const replica = await renderSync({
      projects: [project('owner', 'backlog')],
      tasks: [task('scheduled', { parent: projectParent('owner'), showUpDate: '2026-09-14' })],
    });
    await expectIcon('Empty');
    await act(async () => {
      await replica.projects.setState('owner', 'in-play').isPersisted.promise;
    });
    await expectIcon('OneTask');
    await act(async () => {
      await replica.projects.setState('owner', 'backlog').isPersisted.promise;
    });
    await expectIcon('Empty');
  });

  it('keeps the four-plus icon when another visible task is added', async () => {
    const replica = await renderSync({ tasks: ['1', '2', '3', '4'].map((id) => task(id)) });
    await expectIcon('FourPlusTasks');
    mockSetAppIcon.mockClear();

    await act(async () => {
      await replica.tasks.add('Fifth task').isPersisted.promise;
    });

    expect(replica.snapshot().tasks).toHaveLength(5);
    expect(mockSetAppIcon).not.toHaveBeenCalled();
  });

  it('counts a future task when the local day advances', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    jest.setSystemTime(new Date(2026, 8, 15, 23, 59, 59, 900));
    await renderSync({ tasks: [task('tomorrow', { showUpDate: '2026-09-16' })] });
    await expectIcon('Empty');

    await act(async () => { jest.advanceTimersByTime(200); });

    await expectIcon('OneTask');
  });
});
