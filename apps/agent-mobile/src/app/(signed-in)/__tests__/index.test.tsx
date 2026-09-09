import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  act,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from '@testing-library/react-native';
import { BackHandler, View } from 'react-native';
import { defaultToastController } from '@zero/agent-core';

import type { Capture, Task } from '@/lib/api';
import { resetCapturesApiForTest } from '@/lib/captures-collection';
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
const mockNavigate = jest.fn<(href: string) => void>();
jest.mock('expo-router', () => ({
  router: { navigate: (href: string) => mockNavigate(href) },
}));



// The native Clerk button renders a platform view via requireNativeView, which
// is unavailable under jest. Stub it with a queryable element. The component is
// defined at module scope (mock-prefixed) so the hoisted jest.mock factory needs
// no in-factory JSX (which would reference React out of scope).
const mockUserButton = () => <View accessibilityLabel="Account" />;
jest.mock('@clerk/expo/native', () => ({
  UserButton: () => mockUserButton(),
}));

const mockFetchCaptures = jest.fn<(getToken: unknown) => Promise<Capture[]>>();
const mockAddCapture =
  jest.fn<
    (
      getToken: unknown,
      capture: { id: string; text: string },
    ) => Promise<Capture>
  >();
const mockProcessCapture =
  jest.fn<(getToken: unknown, id: string) => Promise<Capture>>();
const mockUnprocessCapture =
  jest.fn<(getToken: unknown, id: string) => Promise<Capture>>();
const mockEditCapture =
  jest.fn<(getToken: unknown, id: string, text: string) => Promise<Capture>>();
const mockRescheduleCapture =
  jest.fn<
    (getToken: unknown, id: string, showUpDate: string | null) => Promise<Capture>
  >();
const mockReorderCapture =
  jest.fn<
    (getToken: unknown, id: string, sortKey: string) => Promise<Capture>
  >();
const mockFetchProjects =
  jest.fn<(getToken: unknown) => Promise<unknown[]>>();
const mockFetchTasks = jest.fn<(getToken: unknown) => Promise<Task[]>>();
const mockAddTask =
  jest.fn<
    (
      getToken: unknown,
      task: { id: string; text: string; showUpDate: string },
    ) => Promise<Task>
  >();
const mockCompleteTask =
  jest.fn<(getToken: unknown, id: string) => Promise<Task>>();
const mockReopenTask =
  jest.fn<(getToken: unknown, id: string) => Promise<Task>>();
const mockAddProject =
  jest.fn<
    (
      getToken: unknown,
      project: { id: string; title: string; sourceCaptureId: string | null },
    ) => Promise<unknown>
  >();
jest.mock('@/lib/api', () => ({
  fetchCaptures: (getToken: unknown) => mockFetchCaptures(getToken),
  addCapture: (getToken: unknown, capture: { id: string; text: string }) =>
    mockAddCapture(getToken, capture),
  processCapture: (getToken: unknown, id: string) =>
    mockProcessCapture(getToken, id),
  unprocessCapture: (getToken: unknown, id: string) =>
    mockUnprocessCapture(getToken, id),
  editCapture: (getToken: unknown, id: string, text: string) =>
    mockEditCapture(getToken, id, text),
  rescheduleCapture: (getToken: unknown, id: string, showUpDate: string | null) =>
    mockRescheduleCapture(getToken, id, showUpDate),
  reorderCapture: (getToken: unknown, id: string, sortKey: string) =>
    mockReorderCapture(getToken, id, sortKey),
  fetchTasks: (getToken: unknown) => mockFetchTasks(getToken),
  addTask: (
    getToken: unknown,
    task: { id: string; text: string; showUpDate: string },
  ) => mockAddTask(getToken, task),
  completeTask: (getToken: unknown, id: string) => mockCompleteTask(getToken, id),
  reopenTask: (getToken: unknown, id: string) => mockReopenTask(getToken, id),
  // The Home top region reads projects (for the project-active gate and the
  // all-clear call to action).
  fetchProjects: (getToken: unknown) => mockFetchProjects(getToken),
  addProject: (
    getToken: unknown,
    project: { id: string; title: string; sourceCaptureId: string | null },
  ) => mockAddProject(getToken, project),
  // Creating a project from Home pre-warms icon suggestions in the background.
  fetchIconSuggestions: () => Promise.resolve([]),
  setProjectStatus: () => Promise.reject(new Error('not used')),
  editProject: () => Promise.reject(new Error('not used')),
  deleteProject: () => Promise.resolve(),
  // Waiting conditions feed the Home gate; a fetch returning [] is enough.
  fetchWaits: () => Promise.resolve([]),
  addWaitingCondition: () => Promise.reject(new Error('not used')),
  resolveWaitingCondition: () => Promise.reject(new Error('not used')),
  deleteWaitingCondition: () => Promise.resolve(),
}));

const taskRow = (id: string, text: string): Task => ({
  id,
  text,
  showUpDate: '2023-01-01',
  createdAt: '2023-01-01T00:00:00.000Z',
  completedAt: null,
  projectId: null,
  takenOnAt: null,
});

const capture = (
  id: string,
  text: string,
  showUpDate: string | null = null,
  sortKey: string | null = null,
): Capture => ({
  id,
  text,
  createdAt: '2023-01-01T00:00:00.000Z',
  processedAt: null,
  showUpDate,
  sortKey,
});

// Render the screen inside a fresh QueryClient with retries off, so a rejected
// query fails fast and deterministically instead of retrying with backoff.
const renderScreen = () => {
  const client = new QueryClient({
    defaultOptions: {
      // retry off = deterministic failures; gcTime 0 = no lingering gc timer
      // that would keep jest from exiting.
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
    resetCapturesApiForTest();
    resetTasksApiForTest();
    resetProjectsApiForTest();
    resetWaitsApiForTest();
    mockEditCapture.mockReset();
    mockAddTask.mockReset();
    mockCompleteTask.mockReset();
    mockReopenTask.mockReset();
    mockFetchTasks.mockReset();
    mockFetchTasks.mockResolvedValue([]);
    mockFetchProjects.mockReset();
    mockFetchProjects.mockResolvedValue([]);
    mockAddProject.mockReset();
    mockNavigate.mockReset();
    defaultToastController.dismiss();
  });

  it('titles the screen Home', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    const { getByText } = await renderScreen();
    await waitFor(() => expect(getByText('Home')).toBeTruthy());
  });

  it('shows the create call to action when plate and inbox are empty', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    const { getByText } = await renderScreen();
    await waitFor(() =>
      expect(getByText('Create your first project')).toBeTruthy(),
    );
  });

  it('shows the inbox and no call to action when a capture is present', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([capture('1', 'buy milk')]);
    const { getByText, queryByText } = await renderScreen();
    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
    expect(queryByText('Create your first project')).toBeNull();
  });

  it('hides the inbox caption when there are tasks but no captures', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    mockFetchTasks.mockResolvedValue([taskRow('1', 'mail the letter')]);
    const { getByText, queryByText } = await renderScreen();
    await waitFor(() => expect(getByText('mail the letter')).toBeTruthy());
    expect(queryByText('Inbox')).toBeNull();
    expect(queryByText('No captures yet. Capture something.')).toBeNull();
  });

  it('badges a project task on the plate with its project icon', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    mockFetchProjects.mockResolvedValue([
      {
        id: 'p',
        title: 'Diploma',
        icon: '🎓',
        description: null,
        status: 'next',
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    ]);
    mockFetchTasks.mockResolvedValue([
      {
        ...taskRow('1', 'mail the letter'),
        projectId: 'p',
        takenOnAt: '2023-01-02T00:00:00.000Z',
      },
    ]);
    const { getByText } = await renderScreen();
    await waitFor(() => expect(getByText('mail the letter')).toBeTruthy());
    expect(getByText('🎓')).toBeTruthy();
  });

  it('adds a task from the Task quick-add mode', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    mockAddTask.mockImplementation(async (_g, task) => {
      const added: Task = {
        id: task.id,
        text: task.text,
        showUpDate: task.showUpDate,
        createdAt: '2023-01-01T00:00:00.000Z',
        completedAt: null,
        projectId: null,
        takenOnAt: null,
      };
      mockFetchTasks.mockResolvedValue([added]);
      return added;
    });

    const { getByLabelText, getByPlaceholderText, getByText } =
      await renderScreen();
    await waitFor(() =>
      expect(getByText('Create your first project')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Add a task'));
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

  it('creates a project from the Project quick-add mode, stays on Home, and toasts a link to it', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    mockAddProject.mockImplementation(async (_g, project) => ({
      id: project.id,
      title: project.title,
      icon: '📁',
      description: null,
      status: 'next',
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

    // Open the quick-add and switch to Project mode.
    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
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

    // Stays on Home (no navigation yet); the quick-add bar closes after adding.
    expect(queryByPlaceholderText('Name an outcome')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();

    // Settle the optimistic insert (its persist reconciles the server row) so
    // the transaction does not stay pending in @tanstack/db's global state and
    // stall the next test's live queries.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The toast carries the title and a View action that deep-links the project.
    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe('Project created');
    expect(snap[0].description).toBe('ship the app');
    expect(snap[0].action?.label).toBe('View');
    snap[0].action?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/projects');
  });

  it('completes a task immediately and offers Undo in a toast that reopens it', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    mockFetchTasks.mockResolvedValue([taskRow('1', 'mail the letter')]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return {
        ...taskRow('1', 'mail the letter'),
        completedAt: '2023-01-02T00:00:00.000Z',
      };
    });
    mockReopenTask.mockResolvedValue(taskRow('1', 'mail the letter'));

    const { getByLabelText, getByText, queryByText } = await renderScreen();
    expect(getByText('mail the letter')).toBeTruthy();

    // Completing commits the write at once and drops the row (no deferred window).
    await act(async () => {
      fireEvent.press(getByLabelText('Complete "mail the letter"'));
    });
    await waitFor(() => expect(mockCompleteTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByText('mail the letter')).toBeNull());

    // A single Undo toast is offered; tapping it reopens the task on the server.
    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe('Completed');
    expect(snap[0].action?.label).toBe('Undo');
    await act(async () => {
      snap[0].action?.onPress();
    });
    await waitFor(() =>
      expect(mockReopenTask).toHaveBeenCalledWith(expect.anything(), '1'),
    );
  });

  it('shows only one Undo toast when a second task is completed', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    mockFetchTasks.mockResolvedValue([
      taskRow('1', 'mail the letter'),
      taskRow('2', 'call the bank'),
    ]);
    mockCompleteTask.mockImplementation(async (_t: unknown, id: string) => ({
      ...taskRow(id, id),
      completedAt: '2023-01-02T00:00:00.000Z',
    }));

    const { getByLabelText } = await renderScreen();
    await act(async () => {
      fireEvent.press(getByLabelText('Complete "mail the letter"'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Complete "call the bank"'));
    });

    // The fixed toast id means the second completion replaces the first toast.
    expect(defaultToastController.getSnapshot()).toHaveLength(1);
  });

  it('holds the loading text back briefly, then shows it while the first fetch is pending', async () => {
    // Fake timers so the loading-text delay is driven by the test clock, not
    // wall time. Under real timers a loaded CI box can let the 1s delay elapse
    // during the first `await`, flashing the text before the "held back"
    // assertion and failing the test intermittently.
    jest.useFakeTimers();
    try {
      mockGetToken.mockResolvedValue('tok');
      let resolveFetch!: (captures: Capture[]) => void;
      mockFetchCaptures.mockReturnValue(
        new Promise<Capture[]>((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const { getByText, queryByText } = await renderScreen();
      // Flush mount effects and microtasks without advancing the delay timer.
      await act(async () => {});

      // The cached snapshot hydrates fast, so the loading text is held back at
      // first: no spinner flash, and the empty message is not shown either.
      expect(queryByText('Loading your captures…')).toBeNull();
      expect(queryByText('Create your first project')).toBeNull();

      // Only a genuinely slow, still-pending fetch surfaces the loading text,
      // once the delay elapses.
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(getByText('Loading your captures…')).toBeTruthy();

      await act(async () => {
        resolveFetch([]);
      });
      await act(async () => {});

      expect(
        getByText('Create your first project'),
      ).toBeTruthy();
      expect(queryByText('Loading your captures…')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the account button instead of a sign-out button', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);

    const { getByLabelText, queryByText } = await renderScreen();

    expect(getByLabelText('Account')).toBeTruthy();
    expect(queryByText('Sign out')).toBeNull();
  });

  it('surfaces a load error when there is nothing to show', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockRejectedValue(
      new Error('java.net.UnknownHostException'),
    );

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText(/UnknownHostException/)).toBeTruthy());
  });

  it('shows the fetched captures', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([capture('1', 'buy milk')]);

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
  });

  it('reorders: onReorder mints an in-between key and calls reorderCapture for the moved row', async () => {
    // The native long-press-drag can't run under jest; the mock captures the
    // list's onReorder so we can drive it directly and assert the wiring
    // (onReorder -> reorderItems -> orderKeyBetween -> api.reorder). Three keyed
    // rows in order a0 < a1 < a2.
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([
      capture('a', 'Apple', null, 'a0'),
      capture('b', 'Banana', null, 'a1'),
      capture('c', 'Cherry', null, 'a2'),
    ]);
    mockReorderCapture.mockImplementation(async (_t, id, sortKey) => ({
      ...capture(id, id === 'c' ? 'Cherry' : id, null, sortKey),
    }));

    await renderScreen();
    await waitFor(() =>
      expect(typeof (global as { __reorderableOnReorder?: unknown }).__reorderableOnReorder).toBe(
        'function',
      ),
    );

    // Drag the last row (Cherry, index 2) to the top (index 0).
    await act(async () => {
      (
        global as unknown as {
          __reorderableOnReorder: (e: { from: number; to: number }) => void;
        }
      ).__reorderableOnReorder({ from: 2, to: 0 });
    });

    await waitFor(() => expect(mockReorderCapture).toHaveBeenCalledTimes(1));
    // Moved row is Cherry; the new key sorts before the old head (a0).
    expect(mockReorderCapture.mock.calls[0][1]).toBe('c');
    const newKey = mockReorderCapture.mock.calls[0][2];
    expect(typeof newKey).toBe('string');
    expect(newKey < 'a0').toBe(true);
  });

  it('hides a future-dated capture (optimistic visibility)', async () => {
    mockGetToken.mockResolvedValue('tok');
    // The server would filter this out; the mock returns it as-is, so this
    // exercises the client-side visibleCaptures hide.
    mockFetchCaptures.mockResolvedValue([
      capture('1', 'visible now'),
      capture('2', 'later', '2099-01-01'),
    ]);

    const { getByText, queryByText } = await renderScreen();

    await waitFor(() => expect(getByText('visible now')).toBeTruthy());
    expect(queryByText('later')).toBeNull();
  });

  it('processes a capture, removing it from Captures', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([capture('1', 'buy milk')]);
    // The collection refetches after the write; once processed the open Captures list is
    // empty, so the server (mock) then returns [].
    mockProcessCapture.mockImplementation(async () => {
      mockFetchCaptures.mockResolvedValue([]);
      return { ...capture('1', 'buy milk'), processedAt: '2023-01-02T00:00:00.000Z' };
    });

    const { getByText, getByLabelText, queryByText } = await renderScreen();

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Process "buy milk"'));
    });

    await waitFor(() => expect(queryByText('buy milk')).toBeNull());
    expect(mockProcessCapture).toHaveBeenCalledTimes(1);
    expect(mockProcessCapture.mock.calls[0][1]).toBe('1');

    // A single Undo toast is offered; tapping it un-processes the capture.
    mockUnprocessCapture.mockResolvedValue(capture('1', 'buy milk'));
    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe('Completed');
    expect(snap[0].action?.label).toBe('Undo');
    await act(async () => {
      snap[0].action?.onPress();
    });
    await waitFor(() =>
      expect(mockUnprocessCapture).toHaveBeenCalledWith(expect.anything(), '1'),
    );
  });

  it('edits a capture from its detail sheet and shows the new text', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([capture('1', 'buy milk')]);
    mockEditCapture.mockImplementation(async (_g, id, text) => {
      const edited = { ...capture(id, text) };
      mockFetchCaptures.mockResolvedValue([edited]);
      return edited;
    });

    const { getByText, getByLabelText, getByDisplayValue } =
      await renderScreen();

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Edit "buy milk"'));
    });

    const input = getByDisplayValue('buy milk');
    expect(input.props.autoFocus).toBe(true);
    await act(async () => {
      fireEvent.changeText(input, 'buy oat milk');
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Done'));
    });

    await waitFor(() => expect(getByText('buy oat milk')).toBeTruthy());
    expect(mockEditCapture).toHaveBeenCalledTimes(1);
    expect(mockEditCapture.mock.calls[0][1]).toBe('1');
    expect(mockEditCapture.mock.calls[0][2]).toBe('buy oat milk');
  });

  it('does not call edit when the sheet text is unchanged', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([capture('1', 'buy milk')]);

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

    expect(mockEditCapture).not.toHaveBeenCalled();
  });

  it('preserves the stored text when the sheet draft is empty', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([capture('1', 'buy milk')]);

    const { getByText, getByLabelText, getByDisplayValue, queryByLabelText } =
      await renderScreen();

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByLabelText('Edit "buy milk"'));
    });
    await act(async () => {
      fireEvent.changeText(getByDisplayValue('buy milk'), '   ');
      fireEvent.press(getByLabelText('Done'));
    });

    expect(queryByLabelText('sheet')).toBeNull();
    expect(getByText('buy milk')).toBeTruthy();
    expect(mockEditCapture).not.toHaveBeenCalled();
  });

  it('closes the capture sheet before handling quick-add on Android Back', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([capture('1', 'buy milk')]);
    mockEditCapture.mockImplementation(async (_g, id, text) => {
      const edited = { ...capture(id, text) };
      mockFetchCaptures.mockResolvedValue([edited]);
      return edited;
    });
    let onBack: Parameters<typeof BackHandler.addEventListener>[1] | null = null;
    const addListener = jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_event, handler) => {
        onBack = handler;
        return { remove: jest.fn() };
      });

    try {
      const {
        getByText,
        getByLabelText,
        getByDisplayValue,
        getByPlaceholderText,
        queryByLabelText,
      } = await renderScreen();

      await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
      await act(async () => {
        fireEvent.press(getByLabelText('Capture'));
        fireEvent.press(getByLabelText('Edit "buy milk"'));
      });
      expect(getByPlaceholderText('Capture a thought')).toBeTruthy();
      expect(getByLabelText('sheet')).toBeTruthy();
      await act(async () => {
        fireEvent.changeText(getByDisplayValue('buy milk'), 'buy oat milk');
      });

      await act(async () => {
        expect(onBack?.({} as never)).toBe(true);
      });

      expect(queryByLabelText('sheet')).toBeNull();
      expect(getByPlaceholderText('Capture a thought')).toBeTruthy();
      await waitFor(() => expect(getByText('buy oat milk')).toBeTruthy());
      expect(mockEditCapture).toHaveBeenCalledTimes(1);
    } finally {
      addListener.mockRestore();
    }
  });

  it('opens the quick-add input only after tapping the add button', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);

    const { getByLabelText, queryByPlaceholderText } = await renderScreen();

    await waitFor(() =>
      expect(queryByPlaceholderText('Capture a thought')).toBeNull(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });

    expect(queryByPlaceholderText('Capture a thought')).toBeTruthy();
  });

  it('captures typed text and closes the quick-add after adding', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    // The collection refetches after the write; the server (mock) then returns
    // the newly added capture so it survives reconciliation.
    mockAddCapture.mockImplementation(async () => {
      const added = capture('2', 'call mom');
      mockFetchCaptures.mockResolvedValue([added]);
      return added;
    });

    const { getByText, getByLabelText, getByPlaceholderText, queryByPlaceholderText } =
      await renderScreen();

    // Let the initial (empty) load settle before typing, else it can clobber
    // the just-added item.
    await waitFor(() =>
      expect(
        getByText('Create your first project'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });

    const input = getByPlaceholderText('Capture a thought');
    await act(async () => {
      fireEvent.changeText(input, 'call mom');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('call mom')).toBeTruthy());
    expect(mockAddCapture).toHaveBeenCalledTimes(1);
    expect(mockAddCapture.mock.calls[0][1].text).toBe('call mom');

    // The quick-add closes after adding.
    await waitFor(() =>
      expect(queryByPlaceholderText('Capture a thought')).toBeNull(),
    );
  });

  it('confirms before discarding unsaved quick-add text', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);

    const { getByLabelText, getByText, getByPlaceholderText, queryByText } =
      await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Create your first project'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    const input = getByPlaceholderText('Capture a thought');
    await act(async () => {
      fireEvent.changeText(input, 'buy milk');
    });

    // Tapping the backdrop with unsaved text opens the confirm dialog and does
    // NOT clear/close the bar.
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });
    expect(getByText('Discard changes?')).toBeTruthy();
    expect(getByPlaceholderText('Capture a thought').props.value).toBe(
      'buy milk',
    );

    // Cancel keeps editing: dialog gone, text preserved.
    await act(async () => {
      fireEvent.press(getByLabelText('Cancel'));
    });
    expect(queryByText('Discard changes?')).toBeNull();
    expect(getByPlaceholderText('Capture a thought').props.value).toBe(
      'buy milk',
    );
  });

  it('discards the quick-add text when confirming', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);

    const {
      getByLabelText,
      getByText,
      getByPlaceholderText,
      queryByPlaceholderText,
    } = await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Create your first project'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('Capture a thought'), 'buy milk');
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Discard'));
    });

    expect(queryByPlaceholderText('Capture a thought')).toBeNull();
  });

  it('closes the empty quick-add when the keyboard hides (Android back)', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);

    const {
      getByLabelText,
      getByText,
      getByPlaceholderText,
      queryByPlaceholderText,
    } = await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Create your first project'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    expect(getByPlaceholderText('Capture a thought')).toBeTruthy();

    // Android's first Back only hides the keyboard; the empty bar must close.
    await act(async () => {
      (
        globalThis as { __emitKeyboardEvent?: (name: string) => void }
      ).__emitKeyboardEvent?.('keyboardDidHide');
    });

    expect(queryByPlaceholderText('Capture a thought')).toBeNull();
  });

  it('confirms instead of closing when the keyboard hides with unsaved text', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);

    const { getByLabelText, getByText, getByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Create your first project'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('Capture a thought'), 'buy milk');
    });

    await act(async () => {
      (
        globalThis as { __emitKeyboardEvent?: (name: string) => void }
      ).__emitKeyboardEvent?.('keyboardDidHide');
    });

    // Unsaved text: the dialog appears, the bar stays open.
    expect(getByText('Discard changes?')).toBeTruthy();
    expect(getByPlaceholderText('Capture a thought').props.value).toBe(
      'buy milk',
    );
  });

  it('closes the quick-add silently when it is empty', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);

    const { getByLabelText, getByText, queryByText, queryByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Create your first project'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });

    expect(queryByText('Discard changes?')).toBeNull();
    expect(queryByPlaceholderText('Capture a thought')).toBeNull();
  });

  it('re-pulls the captures when the list is pulled to refresh', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([capture('1', 'buy milk')]);

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('buy milk')).toBeTruthy());

    const before = mockFetchCaptures.mock.calls.length;
    await act(async () => {
      pullToRefresh(screen);
    });

    await waitFor(() =>
      expect(mockFetchCaptures.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
