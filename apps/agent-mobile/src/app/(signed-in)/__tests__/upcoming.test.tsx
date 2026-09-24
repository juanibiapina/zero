import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  act,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from '@testing-library/react-native';
import { View } from 'react-native';
import {
  defaultToastController,
  type AddProjectAttention,
  type WaitingCondition,
} from '@zero/agent-core';

import type { Project, Task } from '@/lib/api';
import { resetTasksApiForTest } from '@/lib/tasks-collection';
import { resetProjectsApiForTest } from '@/lib/projects-collection';
import { resetWaitsApiForTest } from '@/lib/waits-collection';

import UpcomingScreen from '../browse/upcoming';

// Trigger pull-to-refresh: the scroll host carries the RefreshControl element on
// its `refreshControl` prop, so invoke that control's onRefresh the way a real
// pull would.
const pullToRefresh = (screen: RenderResult) => {
  const [scroll] = screen.container.queryAll(
    (n) => n.props?.refreshControl != null,
  );
  scroll.props.refreshControl.props.onRefresh();
};

const mockGetToken = jest.fn<() => Promise<string | null>>();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

const mockNavigate = jest.fn<(href: string, options?: unknown) => void>();
jest.mock('expo-router', () => ({
  router: {
    navigate: (href: string, options?: unknown) => mockNavigate(href, options),
  },
}));

const mockUserButton = () => <View accessibilityLabel="Account" />;
jest.mock('@clerk/expo/native', () => ({
  UserButton: () => mockUserButton(),
}));

const mockFetchTasks = jest.fn<(getToken: unknown) => Promise<Task[]>>();
const mockFetchProjects = jest.fn<(getToken: unknown) => Promise<Project[]>>();
const mockFetchWaits = jest.fn<() => Promise<WaitingCondition[]>>();
const mockAddWaitingCondition =
  jest.fn<
    (condition: AddProjectAttention & { id: string }) => Promise<WaitingCondition>
  >();
const mockCompleteTask =
  jest.fn<(getToken: unknown, id: string) => Promise<Task>>();
const mockReopenTask =
  jest.fn<(getToken: unknown, id: string) => Promise<Task>>();
const mockEditTask =
  jest.fn<(getToken: unknown, id: string, text: string) => Promise<Task>>();
const mockRescheduleTask =
  jest.fn<
    (getToken: unknown, id: string, date: string | null) => Promise<Task>
  >();
jest.mock('@/lib/api', () => ({
  fetchTasks: (getToken: unknown) => mockFetchTasks(getToken),
  addTask: jest.fn(),
  completeTask: (getToken: unknown, id: string) => mockCompleteTask(getToken, id),
  reopenTask: (getToken: unknown, id: string) => mockReopenTask(getToken, id),
  editTask: (getToken: unknown, id: string, text: string) =>
    mockEditTask(getToken, id, text),
  rescheduleTask: (getToken: unknown, id: string, date: string | null) =>
    mockRescheduleTask(getToken, id, date),
  reorderTask: jest.fn(),
  setTaskProject: jest.fn(),
  // Upcoming reads projects to show each project task's icon.
  fetchProjects: (getToken: unknown) => mockFetchProjects(getToken),
  addProject: jest.fn(),
  fetchIconSuggestions: () => Promise.resolve([]),
  setProjectState: jest.fn(),
  editProject: jest.fn(),
  deleteProject: () => Promise.resolve(),
  fetchWaits: () => mockFetchWaits(),
  addWaitingCondition: (
    _getToken: unknown,
    condition: AddProjectAttention & { id: string },
  ) => mockAddWaitingCondition(condition),
  resolveWaitingCondition: jest.fn(),
  deleteWaitingCondition: jest.fn(),
}));

const task = (
  id: string,
  text: string,
  showUpDate: string | null = null,
  projectId: string | null = null,
): Task => ({
  id,
  text,
  createdAt: '2023-01-01T00:00:00.000Z',
  completedAt: null,
  showUpDate,
  projectId,
  sortKey: null,
});

const project = (id: string, icon: string): Project => ({
  id,
  title: 'Diploma',
  icon,
  description: null,
  state: 'in-play',
  createdAt: '2023-01-01T00:00:00.000Z',
});

const renderScreen = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpcomingScreen />
    </QueryClientProvider>,
  );
};

describe('UpcomingScreen', () => {
  beforeEach(() => {
    resetTasksApiForTest();
    resetProjectsApiForTest();
    resetWaitsApiForTest();
    mockFetchProjects.mockReset();
    mockFetchProjects.mockResolvedValue([]);
    mockFetchWaits.mockReset();
    mockFetchWaits.mockResolvedValue([]);
    mockAddWaitingCondition.mockReset();
    mockCompleteTask.mockReset();
    mockReopenTask.mockReset();
    mockEditTask.mockReset();
    mockRescheduleTask.mockReset();
    mockNavigate.mockReset();
    defaultToastController.dismiss();
  });

  it('lists a future-dated task and hides an undated one', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([
      task('1', 'undated thought'),
      task('2', 'ship the release', '2099-01-01'),
    ]);

    const { getByText, queryByText } = await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());
    // Undated / shown-up tasks live on Home, never Upcoming.
    expect(queryByText('undated thought')).toBeNull();
  });

  it("shows a project task's icon and none for a loose task", async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('p', '🎓')]);
    mockFetchTasks.mockResolvedValue([
      task('1', 'mail the letter', '2099-01-01', 'p'),
      task('2', 'ship the release', '2099-01-02'),
    ]);

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText('mail the letter')).toBeTruthy());
    expect(getByText('🎓')).toBeTruthy();
    // The loose task carries no project, so no glyph is drawn for it.
    expect(getByText('ship the release')).toBeTruthy();
  });

  it('shows the empty message when nothing is scheduled ahead', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([task('1', 'undated thought')]);

    const { getByText } = await renderScreen();

    await waitFor(() =>
      expect(getByText('Nothing scheduled ahead.')).toBeTruthy(),
    );
  });

  it('completes an upcoming task, removing it', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([task('2', 'ship the release', '2099-01-01')]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return {
        ...task('2', 'ship the release', '2099-01-01'),
        completedAt: '2023-01-02T00:00:00.000Z',
      };
    });

    const { getByText, getByLabelText, queryByText } = await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Complete "ship the release"'));
    });

    await waitFor(() => expect(queryByText('ship the release')).toBeNull());
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask.mock.calls[0][1]).toBe('2');
  });

  it('opens the Project add drawer on Waiting after completion', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('p', '🎓')]);
    mockFetchTasks.mockResolvedValue([
      task('2', 'ship the release', '2099-01-01', 'p'),
    ]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return {
        ...task('2', 'ship the release', '2099-01-01', 'p'),
        completedAt: '2023-01-02T00:00:00.000Z',
      };
    });

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('ship the release')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Complete "ship the release"'));
    await waitFor(() => expect(mockCompleteTask).toHaveBeenCalledTimes(1));

    const toast = defaultToastController.getSnapshot()[0];
    await act(async () => toast?.secondaryAction?.onPress());
    expect(screen.getByPlaceholderText('What needs to happen?')).toBeTruthy();
    expect(screen.getByText('Waiting on')).toBeTruthy();
    expect(screen.getByLabelText('Project Diploma')).toBeTruthy();
    expect(
      screen.getByLabelText('Add a waiting condition').props.accessibilityState
        .selected,
    ).toBe(true);
  });

  it('re-pulls the tasks when the list is pulled to refresh', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([task('2', 'ship the release', '2099-01-01')]);

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('ship the release')).toBeTruthy());

    const before = mockFetchTasks.mock.calls.length;
    await act(async () => {
      pullToRefresh(screen);
    });

    await waitFor(() =>
      expect(mockFetchTasks.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('opens the task detail editor and edits the title', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([task('2', 'ship the release', '2099-01-01')]);
    mockEditTask.mockImplementation(async (_g, id, text) => {
      const edited = task(id, text, '2099-01-01');
      mockFetchTasks.mockResolvedValue([edited]);
      return edited;
    });

    const { getByText, getByLabelText, getByDisplayValue } = await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByLabelText('Edit "ship the release"'));
    });

    const input = getByDisplayValue('ship the release');
    await act(async () => {
      fireEvent.changeText(input, 'ship the big release');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('ship the big release')).toBeTruthy());
    expect(mockEditTask).toHaveBeenCalledTimes(1);
    expect(mockEditTask.mock.calls[0][1]).toBe('2');
    expect(mockEditTask.mock.calls[0][2]).toBe('ship the big release');
  });

  it("jumps from a project task's editor to its project", async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('p', '🎓')]);
    mockFetchTasks.mockResolvedValue([
      task('2', 'ship the release', '2099-01-01', 'p'),
    ]);

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('ship the release')).toBeTruthy());
    await act(async () =>
      fireEvent.press(screen.getByLabelText('Edit "ship the release"')),
    );
    await act(async () =>
      fireEvent.press(screen.getByLabelText('Open project Diploma')),
    );

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p', {
      withAnchor: true,
    });
    expect(screen.queryByLabelText('sheet')).toBeNull();
  });

  it('clears an upcoming task schedule without a toast', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([task('2', 'ship the release', '2099-01-01')]);
    mockRescheduleTask.mockResolvedValue(task('2', 'ship the release', null));

    const { getByText, getByLabelText } = await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByLabelText('Edit "ship the release"'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Set schedule'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('No date'));
    });

    await waitFor(() => expect(mockRescheduleTask).toHaveBeenCalledTimes(1));
    expect(mockRescheduleTask.mock.calls[0][1]).toBe('2');
    expect(mockRescheduleTask.mock.calls[0][2]).toBeNull();
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it('completes a task from the detail round check', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([task('2', 'ship the release', '2099-01-01')]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return {
        ...task('2', 'ship the release', '2099-01-01'),
        completedAt: '2023-01-02T00:00:00.000Z',
      };
    });

    const { getByText, getByLabelText, queryByText, queryByLabelText } =
      await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByLabelText('Edit "ship the release"'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Complete task'));
    });

    await waitFor(() => expect(queryByLabelText('sheet')).toBeNull());
    await waitFor(() => expect(queryByText('ship the release')).toBeNull());
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask.mock.calls[0][1]).toBe('2');
  });
});
