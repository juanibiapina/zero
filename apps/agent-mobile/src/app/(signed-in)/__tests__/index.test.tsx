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

import type { Task } from '@/lib/api';
import { resetTasksApiForTest } from '@/lib/tasks-collection';
import { resetProjectsApiForTest } from '@/lib/projects-collection';
import { resetWaitsApiForTest } from '@/lib/waits-collection';

import HomeScreen from '../index';

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

// The screen navigates via the expo-router singleton; capture it.
const mockNavigate = jest.fn<(href: string, options?: unknown) => void>();
jest.mock('expo-router', () => ({
  router: {
    navigate: (href: string, options?: unknown) => mockNavigate(href, options),
  },
}));

// The native Clerk button renders a platform view via requireNativeView, which
// is unavailable under jest. Stub it with a queryable element.
const mockUserButton = () => <View accessibilityLabel="Account" />;
jest.mock('@clerk/expo/native', () => ({
  UserButton: () => mockUserButton(),
}));

const mockFetchTasks = jest.fn<(getToken: unknown) => Promise<Task[]>>();
const mockAddTask =
  jest.fn<
    (
      getToken: unknown,
      task: {
        id: string;
        text: string;
        showUpDate: string | null;
        projectId: string | null;
        recurrence?: Task['recurrence'];
      },
    ) => Promise<Task>
  >();
const mockCompleteTask =
  jest.fn<(getToken: unknown, id: string) => Promise<Task>>();
const mockReopenTask =
  jest.fn<(getToken: unknown, id: string) => Promise<Task>>();
const mockEditTask =
  jest.fn<(getToken: unknown, id: string, text: string) => Promise<Task>>();
const mockRescheduleTask =
  jest.fn<
    (getToken: unknown, id: string, showUpDate: string | null) => Promise<Task>
  >();
const mockReorderTask =
  jest.fn<(getToken: unknown, id: string, sortKey: string) => Promise<Task>>();
const mockFetchProjects =
  jest.fn<(getToken: unknown) => Promise<unknown[]>>();
const mockFetchWaits = jest.fn<() => Promise<WaitingCondition[]>>();
const mockAddWaitingCondition =
  jest.fn<
    (condition: AddProjectAttention & { id: string }) => Promise<WaitingCondition>
  >();
const mockAddProject =
  jest.fn<
    (
      getToken: unknown,
      project: { id: string; title: string; sourceCaptureId: string | null },
    ) => Promise<unknown>
  >();
jest.mock('@/lib/api', () => ({
  fetchTasks: (getToken: unknown) => mockFetchTasks(getToken),
  addTask: (
    getToken: unknown,
    task: {
        id: string;
        text: string;
        showUpDate: string | null;
        projectId: string | null;
        recurrence?: Task['recurrence'];
      },
  ) => mockAddTask(getToken, task),
  completeTask: (getToken: unknown, id: string) => mockCompleteTask(getToken, id),
  reopenTask: (getToken: unknown, id: string) => mockReopenTask(getToken, id),
  editTask: (getToken: unknown, id: string, text: string) =>
    mockEditTask(getToken, id, text),
  rescheduleTask: (getToken: unknown, id: string, showUpDate: string | null) =>
    mockRescheduleTask(getToken, id, showUpDate),
  reorderTask: (getToken: unknown, id: string, sortKey: string) =>
    mockReorderTask(getToken, id, sortKey),
  setTaskProject: () => Promise.reject(new Error('not used')),
  // Home reads projects (for the project-active gate and the all-clear CTA).
  fetchProjects: (getToken: unknown) => mockFetchProjects(getToken),
  addProject: (
    getToken: unknown,
    project: { id: string; title: string; sourceCaptureId: string | null },
  ) => mockAddProject(getToken, project),
  fetchIconSuggestions: () => Promise.resolve([]),
  setProjectState: () => Promise.reject(new Error('not used')),
  editProject: () => Promise.reject(new Error('not used')),
  deleteProject: () => Promise.resolve(),
  // Waiting conditions feed the Home gate; a fetch returning [] is enough.
  fetchWaits: () => mockFetchWaits(),
  addWaitingCondition: (
    _getToken: unknown,
    condition: AddProjectAttention & { id: string },
  ) => mockAddWaitingCondition(condition),
  resolveWaitingCondition: () => Promise.reject(new Error('not used')),
  deleteWaitingCondition: () => Promise.resolve(),
}));

// A loose task (null showUpDate = always shown up on Home).
const taskRow = (id: string, text: string, over: Partial<Task> = {}): Task => ({
  id,
  text,
  showUpDate: over.showUpDate === undefined ? null : over.showUpDate,
  createdAt: '2023-01-01T00:00:00.000Z',
  completedAt: over.completedAt ?? null,
  projectId: over.projectId ?? null,
  sortKey: over.sortKey ?? null,
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
      <HomeScreen />
    </QueryClientProvider>,
  );
};

describe('HomeScreen', () => {
  beforeEach(() => {
    resetTasksApiForTest();
    resetProjectsApiForTest();
    resetWaitsApiForTest();
    mockEditTask.mockReset();
    mockCompleteTask.mockReset();
    mockReopenTask.mockReset();
    mockRescheduleTask.mockReset();
    mockReorderTask.mockReset();
    mockAddTask.mockReset();
    mockFetchTasks.mockReset();
    mockFetchTasks.mockResolvedValue([]);
    mockFetchProjects.mockReset();
    mockFetchProjects.mockResolvedValue([]);
    mockFetchWaits.mockReset();
    mockFetchWaits.mockResolvedValue([]);
    mockAddWaitingCondition.mockReset();
    mockAddProject.mockReset();
    mockNavigate.mockReset();
    defaultToastController.dismiss();
  });

  it('titles the screen Home', async () => {
    mockGetToken.mockResolvedValue('tok');
    const { getByText } = await renderScreen();
    await waitFor(() => expect(getByText('Home')).toBeTruthy());
  });

  it('shows the create call to action when the list is empty', async () => {
    mockGetToken.mockResolvedValue('tok');
    const { getByText } = await renderScreen();
    await waitFor(() =>
      expect(getByText('Create your first project')).toBeTruthy(),
    );
  });

  it('renders a loose task and no call to action', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([taskRow('1', 'buy milk')]);
    const { getByText, queryByText } = await renderScreen();
    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
    expect(queryByText('Create your first project')).toBeNull();
  });

  it('badges a project task with its project icon', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([
      {
        id: 'p',
        title: 'Diploma',
        icon: '🎓',
        description: null,
        state: 'in-play',
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    ]);
    mockFetchTasks.mockResolvedValue([
      taskRow('1', 'mail the letter', {
        projectId: 'p',
        showUpDate: '2023-01-02',
      }),
    ]);
    const { getByText } = await renderScreen();
    await waitFor(() => expect(getByText('mail the letter')).toBeTruthy());
    expect(getByText('🎓')).toBeTruthy();
  });

  it('shows arrived Project Tasks despite an unresolved After relationship', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([
      {
        id: 'p',
        title: 'Move house',
        icon: '🏠',
        description: null,
        state: 'in-play',
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    ]);
    mockFetchTasks.mockResolvedValue([
      taskRow('t', 'pack boxes', {
        projectId: 'p',
        showUpDate: '2023-01-01',
      }),
    ]);
    mockFetchWaits.mockResolvedValue([
      {
        id: 'dependency',
        projectId: 'p',
        kind: 'project-status',
        text: null,
        refId: 'missing-prerequisite',
        targetStatus: 'done',
        resolvedAt: null,
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    ]);

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('pack boxes')).toBeTruthy());
    expect(screen.queryByText('Nothing needs attention right now')).toBeNull();
  });

  it('adds a loose task from the default quick-add', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockAddTask.mockImplementation(async (_g, task) => {
      const added = taskRow(task.id, task.text);
      mockFetchTasks.mockResolvedValue([added]);
      return added;
    });

    const { getByLabelText, getByPlaceholderText, getByText } =
      await renderScreen();
    await waitFor(() =>
      expect(getByText('Create your first project')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Task'));
    });
    const input = getByPlaceholderText('Add a task');
    await act(async () => {
      fireEvent.changeText(input, 'call the dentist');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('call the dentist')).toBeTruthy());
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockAddTask.mock.calls[0][1].text).toBe('call the dentist');
  });

  it('highlights and creates a recurring task from natural-language quick-add', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockAddTask.mockImplementation(async (_g, task) => {
      const added = {
        ...taskRow(task.id, task.text, { showUpDate: task.showUpDate }),
        recurrence: task.recurrence ?? null,
        recurrenceDate: task.recurrence?.origin ?? null,
      };
      mockFetchTasks.mockResolvedValue([added]);
      return added;
    });

    const screen = await renderScreen();
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Task'));
    });
    await act(async () => {
      await fireEvent.changeText(
        screen.getByPlaceholderText('Add a task'),
        'stand up every day',
      );
    });

    expect(
      screen.getByTestId('schedule-highlight', {
        includeHiddenElements: true,
      }).props.children,
    ).toBe('every day');
    await act(async () => {
      await fireEvent(
        screen.getByPlaceholderText('Add a task'),
        'submitEditing',
      );
    });

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledTimes(1));
    expect(mockAddTask.mock.calls[0][1].text).toBe('stand up');
    expect(mockAddTask.mock.calls[0][1].recurrence?.pattern).toEqual({
      unit: 'day',
      interval: 1,
    });
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it('creates a loose task for tomorrow without a toast', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockAddTask.mockImplementation(async (_g, task) =>
      taskRow(task.id, task.text, { showUpDate: task.showUpDate }),
    );

    const screen = await renderScreen();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Task'));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByPlaceholderText('Add a task'), 'buy milk tomorrow');
    });
    await act(async () => {
      fireEvent(screen.getByPlaceholderText('Add a task'), 'submitEditing');
    });

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledTimes(1));
    expect(mockAddTask.mock.calls[0][1].text).toBe('buy milk');
    expect(mockAddTask.mock.calls[0][1].showUpDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it('falls back to the previous date when the active highlight is tapped', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockAddTask.mockImplementation(async (_g, task) => {
      const added = taskRow(task.id, task.text, {
        showUpDate: task.showUpDate,
      });
      mockFetchTasks.mockResolvedValue([added]);
      return added;
    });

    const screen = await renderScreen();
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Task'));
    });
    const input = screen.getByPlaceholderText('Add a task');
    await act(async () => {
      await fireEvent.changeText(input, 'Work today tomorrow');
    });
    expect(
      screen.getByTestId('schedule-highlight', {
        includeHiddenElements: true,
      }).props.children,
    ).toBe('tomorrow');

    await act(async () => {
      await fireEvent(input, 'selectionChange', {
        nativeEvent: { selection: { start: 14, end: 14 } },
      });
    });
    expect(
      screen.getByTestId('schedule-highlight', {
        includeHiddenElements: true,
      }).props.children,
    ).toBe('today');

    await act(async () => {
      await fireEvent(input, 'submitEditing');
    });
    await waitFor(() => expect(mockAddTask).toHaveBeenCalledTimes(1));
    expect(mockAddTask.mock.calls[0][1].text).toBe('Work tomorrow');
    expect(mockAddTask.mock.calls[0][1].showUpDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mockAddTask.mock.calls[0][1].recurrence ?? null).toBeNull();
  });

  it('files a dateless task to a project from the composer: off Home', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([
      {
        id: 'p',
        title: 'Diploma',
        icon: '🎓',
        description: null,
        state: 'in-play',
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    ]);
    mockAddTask.mockImplementation(async (_g, task) => {
      const added = taskRow(task.id, task.text, {
        projectId: task.projectId,
        showUpDate: task.showUpDate,
      });
      mockFetchTasks.mockResolvedValue([added]);
      return added;
    });

    const { getByLabelText, getByPlaceholderText, queryByText } =
      await renderScreen();

    await act(async () => {
      fireEvent.press(getByLabelText('Task'));
    });
    // Pick the project from the composer's project row.
    await act(async () => {
      fireEvent.press(getByLabelText('No project'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Diploma'));
    });
    const input = getByPlaceholderText('Add a task');
    await act(async () => {
      fireEvent.changeText(input, 'write thesis');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledTimes(1));
    // Filed with a project and no date, so it is groomed — not on Home.
    expect(mockAddTask.mock.calls[0][1].projectId).toBe('p');
    expect(mockAddTask.mock.calls[0][1].showUpDate).toBeNull();
    expect(queryByText('write thesis')).toBeNull();
    expect(defaultToastController.getSnapshot()[0]?.message).toBe('Filed to project');
  });

  it('creates a project from the Project quick-add mode, stays on Home, and toasts a link', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockAddProject.mockImplementation(async (_g, project) => ({
      id: project.id,
      title: project.title,
      icon: '📁',
      description: null,
      state: 'in-play',
      createdAt: '2023-01-01T00:00:00.000Z',
    }));

    const {
      getByLabelText,
      getByPlaceholderText,
      queryByPlaceholderText,
      getByText,
    } = await renderScreen();
    await waitFor(() =>
      expect(getByText('Create your first project')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Task'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Add a project'));
    });
    const input = getByPlaceholderText('Name an outcome');
    await act(async () => {
      fireEvent.changeText(input, 'ship the app');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(mockAddProject).toHaveBeenCalledTimes(1));
    const minted = mockAddProject.mock.calls[0][1];
    expect(minted.title).toBe('ship the app');
    expect(queryByPlaceholderText('Name an outcome')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe('Project created');
    expect(snap[0].description).toBe('ship the app');
    expect(snap[0].action?.label).toBe('View');
    snap[0].action?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith(`/projects/${minted.id}`, {
      withAnchor: true,
    });
  });

  it('completes a task immediately and offers Undo in a toast that reopens it', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([taskRow('1', 'mail the letter')]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return taskRow('1', 'mail the letter', {
        completedAt: '2023-01-02T00:00:00.000Z',
      });
    });
    mockReopenTask.mockResolvedValue(taskRow('1', 'mail the letter'));

    const { getByLabelText, getByText, queryByText } = await renderScreen();
    await waitFor(() => expect(getByText('mail the letter')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Complete "mail the letter"'));
    });
    await waitFor(() => expect(mockCompleteTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByText('mail the letter')).toBeNull());

    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe('Completed');
    expect(snap[0].action?.label).toBe('Undo');
    expect(snap[0].description).toBeUndefined();
    expect(snap[0].link).toBeUndefined();
    await act(async () => {
      snap[0].action?.onPress();
    });
    await waitFor(() =>
      expect(mockReopenTask).toHaveBeenCalledWith(expect.anything(), '1'),
    );
  });

  it('opens the Project add drawer on Waiting after completion', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([
      {
        id: 'p',
        title: 'Diploma',
        icon: '🎓',
        description: null,
        state: 'in-play',
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    ]);
    mockFetchTasks.mockResolvedValue([
      taskRow('1', 'mail the letter', {
        projectId: 'p',
        showUpDate: '2023-01-02',
      }),
    ]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return taskRow('1', 'mail the letter', {
        projectId: 'p',
        completedAt: '2023-01-02T00:00:00.000Z',
      });
    });

    const { getByLabelText, getByPlaceholderText, getByText, queryByText } =
      await renderScreen();
    await waitFor(() => expect(getByText('mail the letter')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Complete "mail the letter"'));
    });
    await waitFor(() => expect(mockCompleteTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByText('mail the letter')).toBeNull());

    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].description).toBe('🎓 Diploma');
    expect(snap[0].secondaryAction?.label).toBe('Waiting for…');
    expect(snap[0].descriptionAction?.accessibilityLabel).toBe('Open project Diploma');
    await act(async () => snap[0].secondaryAction?.onPress());
    expect(getByPlaceholderText('What needs to happen?')).toBeTruthy();
    expect(getByText('Waiting on')).toBeTruthy();
    expect(getByLabelText('Project Diploma')).toBeTruthy();
    expect(
      getByLabelText('Add a waiting condition').props.accessibilityState.selected,
    ).toBe(true);
    snap[0].descriptionAction?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p', {
      withAnchor: true,
    });
  });

  it('shows only one Undo toast when a second task is completed', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([
      taskRow('1', 'mail the letter'),
      taskRow('2', 'call the bank'),
    ]);
    mockCompleteTask.mockImplementation(async (_t: unknown, id: string) =>
      taskRow(id, id, { completedAt: '2023-01-02T00:00:00.000Z' }),
    );

    const { getByLabelText } = await renderScreen();
    await act(async () => {
      fireEvent.press(getByLabelText('Complete "mail the letter"'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Complete "call the bank"'));
    });

    expect(defaultToastController.getSnapshot()).toHaveLength(1);
  });

  it('shows the account button instead of a sign-out button', async () => {
    mockGetToken.mockResolvedValue('tok');
    const { getByLabelText, queryByText } = await renderScreen();
    expect(getByLabelText('Account')).toBeTruthy();
    expect(queryByText('Sign out')).toBeNull();
  });

  it('surfaces a load error when there is nothing to show', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockRejectedValue(
      new Error('java.net.UnknownHostException'),
    );
    const { getByText } = await renderScreen();
    await waitFor(() => expect(getByText(/UnknownHostException/)).toBeTruthy());
  });

  it('hides a future-dated task (it belongs to Upcoming)', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([
      taskRow('1', 'visible now'),
      taskRow('2', 'later', { showUpDate: '2099-01-01' }),
    ]);
    const { getByText, queryByText } = await renderScreen();
    await waitFor(() => expect(getByText('visible now')).toBeTruthy());
    expect(queryByText('later')).toBeNull();
  });

  it('edits a task from its detail sheet and shows the new text', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([taskRow('1', 'buy milk')]);
    mockEditTask.mockImplementation(async (_g, id, text) => {
      const edited = taskRow(id, text);
      mockFetchTasks.mockResolvedValue([edited]);
      return edited;
    });

    const { getByText, getByLabelText, getByDisplayValue, queryByLabelText } =
      await renderScreen();
    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Edit "buy milk"'));
    });
    expect(queryByLabelText(/^Open project /)).toBeNull();
    const input = getByDisplayValue('buy milk');
    await act(async () => {
      fireEvent.changeText(input, 'buy oat milk');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('buy oat milk')).toBeTruthy());
    expect(mockEditTask).toHaveBeenCalledTimes(1);
    expect(mockEditTask.mock.calls[0][1]).toBe('1');
    expect(mockEditTask.mock.calls[0][2]).toBe('buy oat milk');
  });

  it('saves a renamed task and jumps to its project from the editor icon', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([
      {
        id: 'p',
        title: 'Diploma',
        icon: '🎓',
        description: null,
        state: 'in-play',
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    ]);
    let task = taskRow('1', 'mail the letter', {
      projectId: 'p',
      showUpDate: '2023-01-02',
    });
    mockFetchTasks.mockImplementation(async () => [task]);
    mockEditTask.mockImplementation(async (_token, _id, text) => {
      task = { ...task, text };
      return task;
    });

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('mail the letter')).toBeTruthy());
    await act(async () =>
      fireEvent.press(screen.getByLabelText('Edit "mail the letter"')),
    );
    await act(async () =>
      fireEvent.changeText(screen.getByLabelText('Task text'), 'mail the signed letter'),
    );
    await act(async () =>
      fireEvent.press(screen.getByLabelText('Open project Diploma')),
    );

    await waitFor(() =>
      expect(mockEditTask).toHaveBeenCalledWith(
        expect.anything(),
        '1',
        'mail the signed letter',
      ),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p', {
      withAnchor: true,
    });
    expect(screen.queryByLabelText('sheet')).toBeNull();
  });

  it.each(['Set schedule', 'Set project', 'Complete task'])(
    'saves a renamed task before %s', async (action) => {
      mockGetToken.mockResolvedValue('tok');
      let task = taskRow('1', 'original');
      mockFetchTasks.mockImplementation(async () => [task]);
      mockEditTask.mockImplementation(async (_token, _id, text) => {
        task = { ...task, text };
        return task;
      });
      mockCompleteTask.mockImplementation(async () => {
        task = { ...task, completedAt: new Date().toISOString() };
        return task;
      });
      const screen = await renderScreen();
      await waitFor(() => expect(screen.getByText('original')).toBeTruthy());
      await act(async () => fireEvent.press(screen.getByLabelText('Edit "original"')));
      await act(async () => fireEvent.changeText(screen.getByLabelText('Task text'), 'renamed'));
      await act(async () => fireEvent.press(screen.getByLabelText(action)));
      await waitFor(() => expect(task.text).toBe('renamed'));
      if (action === 'Complete task') {
        mockReopenTask.mockImplementation(async () => {
          task = { ...task, completedAt: null };
          return task;
        });
        await act(async () => defaultToastController.getSnapshot()[0].action?.onPress());
        await waitFor(() => expect(screen.getByText('renamed')).toBeTruthy());
      }
    },
  );

  it('does not call edit when the sheet text is unchanged', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([taskRow('1', 'buy milk')]);

    const { getByText, getByLabelText, getByDisplayValue } =
      await renderScreen();
    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Edit "buy milk"'));
    });
    const input = getByDisplayValue('buy milk');
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    expect(mockEditTask).not.toHaveBeenCalled();
  });

  it('completes a task from its detail sheet via the round check', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([taskRow('1', 'buy milk')]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return taskRow('1', 'buy milk', {
        completedAt: '2023-01-02T00:00:00.000Z',
      });
    });

    const { getByText, getByLabelText, queryByText, queryByLabelText } =
      await renderScreen();
    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Edit "buy milk"'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Complete task'));
    });

    await waitFor(() => expect(queryByLabelText('sheet')).toBeNull());
    await waitFor(() => expect(queryByText('buy milk')).toBeNull());
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask.mock.calls[0][1]).toBe('1');
  });

  it('postpones a Home row to Tomorrow without a toast', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([taskRow('1', 'buy milk')]);
    mockRescheduleTask.mockImplementation(async (_token, id, date) =>
      taskRow(id, 'buy milk', { showUpDate: date }),
    );

    const { getByText } = await renderScreen();
    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
    expect(getByText('Tomorrow')).toBeTruthy();

    const pan = (global as unknown as {
      __lastPanGesture: {
        __onStart: () => void;
        __onUpdate: (event: { translationX: number }) => void;
        __onEnd: (event: { velocityX: number }) => void;
      };
    }).__lastPanGesture;
    await act(async () => {
      pan.__onStart();
      pan.__onUpdate({ translationX: 160 });
      pan.__onEnd({ velocityX: 0 });
    });

    await waitFor(() => expect(mockRescheduleTask).toHaveBeenCalledTimes(1));
    expect(mockRescheduleTask.mock.calls[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it('schedules a task to tomorrow from the scheduler', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([taskRow('1', 'buy milk')]);
    mockRescheduleTask.mockResolvedValue(taskRow('1', 'buy milk'));

    const { getByText, getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Edit "buy milk"'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Set schedule'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Tomorrow'));
    });

    await waitFor(() => expect(mockRescheduleTask).toHaveBeenCalledTimes(1));
    expect(mockRescheduleTask.mock.calls[0][1]).toBe('1');
    expect(mockRescheduleTask.mock.calls[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it('reorders: onReorder mints an in-between key and calls reorderTask for the moved row', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([
      taskRow('a', 'Apple', { sortKey: 'a0' }),
      taskRow('b', 'Banana', { sortKey: 'a1' }),
      taskRow('c', 'Cherry', { sortKey: 'a2' }),
    ]);
    mockReorderTask.mockImplementation(async (_t, id, sortKey) =>
      taskRow(id, id, { sortKey }),
    );

    await renderScreen();
    await waitFor(() =>
      expect(
        typeof (global as { __reorderableOnReorder?: unknown })
          .__reorderableOnReorder,
      ).toBe('function'),
    );

    await act(async () => {
      (
        global as unknown as {
          __reorderableOnReorder: (e: { from: number; to: number }) => void;
        }
      ).__reorderableOnReorder({ from: 2, to: 0 });
    });

    await waitFor(() => expect(mockReorderTask).toHaveBeenCalledTimes(1));
    expect(mockReorderTask.mock.calls[0][1]).toBe('c');
    const newKey = mockReorderTask.mock.calls[0][2];
    expect(typeof newKey).toBe('string');
    expect(newKey < 'a0').toBe(true);
  });

  it('opens the quick-add input only after tapping the add button', async () => {
    mockGetToken.mockResolvedValue('tok');
    const { getByLabelText, queryByPlaceholderText } = await renderScreen();

    await waitFor(() =>
      expect(queryByPlaceholderText('Add a task')).toBeNull(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Task'));
    });

    expect(queryByPlaceholderText('Add a task')).toBeTruthy();
  });

  it('confirms before discarding unsaved quick-add text', async () => {
    mockGetToken.mockResolvedValue('tok');
    const { getByLabelText, getByText, getByPlaceholderText, queryByText } =
      await renderScreen();
    await waitFor(() =>
      expect(getByText('Create your first project')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Task'));
    });
    const input = getByPlaceholderText('Add a task');
    await act(async () => {
      fireEvent.changeText(input, 'buy milk');
    });

    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });
    expect(getByText('Discard changes?')).toBeTruthy();
    expect(getByPlaceholderText('Add a task').props.value).toBe('buy milk');

    await act(async () => {
      fireEvent.press(getByLabelText('Cancel'));
    });
    expect(queryByText('Discard changes?')).toBeNull();
    expect(getByPlaceholderText('Add a task').props.value).toBe('buy milk');
  });

  it('discards the quick-add text when confirming', async () => {
    mockGetToken.mockResolvedValue('tok');
    const {
      getByLabelText,
      getByText,
      getByPlaceholderText,
      queryByPlaceholderText,
    } = await renderScreen();
    await waitFor(() =>
      expect(getByText('Create your first project')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Task'));
    });
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('Add a task'), 'buy milk');
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Discard'));
    });

    expect(queryByPlaceholderText('Add a task')).toBeNull();
  });

  it('keeps the create drawer open when the keyboard hides, then closes on dismissal', async () => {
    mockGetToken.mockResolvedValue('tok');
    const { getByLabelText, getByText, getByPlaceholderText, queryByPlaceholderText } =
      await renderScreen();
    await waitFor(() =>
      expect(getByText('Create your first project')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Task'));
    });
    expect(getByPlaceholderText('Add a task')).toBeTruthy();

    await act(async () => {
      (
        globalThis as { __emitKeyboardEvent?: (name: string) => void }
      ).__emitKeyboardEvent?.('keyboardDidHide');
    });

    expect(getByPlaceholderText('Add a task')).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });
    expect(queryByPlaceholderText('Add a task')).toBeNull();
  });

  it('re-pulls the tasks when the list is pulled to refresh', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([taskRow('1', 'buy milk')]);

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('buy milk')).toBeTruthy());

    const before = mockFetchTasks.mock.calls.length;
    await act(async () => {
      pullToRefresh(screen);
    });

    await waitFor(() =>
      expect(mockFetchTasks.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('re-pulls every Home collection when the empty state is pulled to refresh', async () => {
    mockGetToken.mockResolvedValue('tok');

    const screen = await renderScreen();
    await waitFor(() =>
      expect(screen.getByText('Create your first project')).toBeTruthy(),
    );
    const tasksBefore = mockFetchTasks.mock.calls.length;
    const projectsBefore = mockFetchProjects.mock.calls.length;
    const waitsBefore = mockFetchWaits.mock.calls.length;

    await act(async () => {
      pullToRefresh(screen);
    });

    await waitFor(() => {
      expect(mockFetchTasks.mock.calls.length).toBeGreaterThan(tasksBefore);
      expect(mockFetchProjects.mock.calls.length).toBeGreaterThan(projectsBefore);
      expect(mockFetchWaits.mock.calls.length).toBeGreaterThan(waitsBefore);
    });
  });

  it('shows a task when its local day arrives without refetching', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 8, 15, 23, 59, 50));
    mockGetToken.mockResolvedValue('tok');
    mockFetchTasks.mockResolvedValue([
      taskRow('tomorrow', 'arrived overnight', {
        showUpDate: '2026-09-16',
      }),
    ]);

    const screen = await renderScreen();
    await waitFor(() =>
      expect(screen.getByText('Create your first project')).toBeTruthy(),
    );
    expect(screen.queryByText('arrived overnight')).toBeNull();
    const fetchesBeforeMidnight = mockFetchTasks.mock.calls.length;

    await act(async () => {
      jest.advanceTimersByTime(10_001);
    });

    expect(screen.getByText('arrived overnight')).toBeTruthy();
    expect(mockFetchTasks).toHaveBeenCalledTimes(fetchesBeforeMidnight);
    await screen.unmount();
    jest.useRealTimers();
  });
});
