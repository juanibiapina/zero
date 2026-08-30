import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import { localToday } from '@zero/agent-core';

import type { Capture, Task } from '@/lib/api';

import HomeScreen from '../index';

const mockGetToken = jest.fn<() => Promise<string | null>>();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

// The native Clerk button renders a platform view via requireNativeView, which
// is unavailable under jest. Stub it with a queryable element. The component is
// defined at module scope (mock-prefixed) so the jest.mock factory needs no
// createElement/JSX, which NativeWind's babel transform would reject inside it.
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
const mockEditCapture =
  jest.fn<(getToken: unknown, id: string, text: string) => Promise<Capture>>();
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
jest.mock('@/lib/api', () => ({
  fetchCaptures: (getToken: unknown) => mockFetchCaptures(getToken),
  addCapture: (getToken: unknown, capture: { id: string; text: string }) =>
    mockAddCapture(getToken, capture),
  processCapture: (getToken: unknown, id: string) =>
    mockProcessCapture(getToken, id),
  editCapture: (getToken: unknown, id: string, text: string) =>
    mockEditCapture(getToken, id, text),
  fetchTasks: (getToken: unknown) => mockFetchTasks(getToken),
  addTask: (
    getToken: unknown,
    task: { id: string; text: string; showUpDate: string },
  ) => mockAddTask(getToken, task),
  completeTask: (getToken: unknown, id: string) =>
    mockCompleteTask(getToken, id),
}));

const capture = (id: string, text: string): Capture => ({
  id,
  text,
  createdAt: '2023-01-01T00:00:00.000Z',
  processedAt: null,
});

const task = (id: string, text: string, showUpDate: string): Task => ({
  id,
  text,
  createdAt: '2023-01-01T00:00:00.000Z',
  showUpDate,
  completedAt: null,
});

// Both panels mount at once, so every render needs the Today data layer stubbed
// too. Default it to an empty list unless a test overrides it.
beforeEach(() => {
  mockFetchTasks.mockResolvedValue([]);
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
      expect(queryByText('No captures yet. Capture something.')).toBeNull();

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
        getByText('No captures yet. Capture something.'),
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
  });

  it('edits a capture inline and shows the new text', async () => {
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

    // Tap the row text to enter edit mode.
    await act(async () => {
      fireEvent.press(getByLabelText('Edit "buy milk"'));
    });

    const input = getByDisplayValue('buy milk');
    await act(async () => {
      fireEvent.changeText(input, 'buy oat milk');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('buy oat milk')).toBeTruthy());
    expect(mockEditCapture).toHaveBeenCalledTimes(1);
    expect(mockEditCapture.mock.calls[0][1]).toBe('1');
    expect(mockEditCapture.mock.calls[0][2]).toBe('buy oat milk');
  });

  it('does not call edit when the text is unchanged', async () => {
    // Module-level mocks are not auto-cleared between tests; drop any prior call.
    mockEditCapture.mockClear();
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

  it('captures typed text and keeps the input open and cleared for the next one', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    // The collection refetches after the write; the server (mock) then returns
    // the newly added capture so it survives reconciliation.
    mockAddCapture.mockImplementation(async () => {
      const added = capture('2', 'call mom');
      mockFetchCaptures.mockResolvedValue([added]);
      return added;
    });

    const { getByText, getByLabelText, getByPlaceholderText } =
      await renderScreen();

    // Let the initial (empty) load settle before typing, else it can clobber
    // the just-added item.
    await waitFor(() =>
      expect(
        getByText('No captures yet. Capture something.'),
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

    // The quick-add input stays open and cleared for rapid capture.
    const reopened = getByPlaceholderText('Capture a thought');
    expect(reopened.props.value).toBe('');
  });

  it('confirms before discarding unsaved quick-add text', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);

    const { getByLabelText, getByText, getByPlaceholderText, queryByText } =
      await renderScreen();

    await waitFor(() =>
      expect(
        getByText('No captures yet. Capture something.'),
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
        getByText('No captures yet. Capture something.'),
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
        getByText('No captures yet. Capture something.'),
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
        getByText('No captures yet. Capture something.'),
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
        getByText('No captures yet. Capture something.'),
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
});

describe('Today tab', () => {
  it('shows tasks due on or before today and hides future ones', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    mockFetchTasks.mockResolvedValue([
      task('1', 'ship it', '2020-01-01'), // overdue: shown
      task('2', 'next year', '2999-01-01'), // future: hidden
    ]);

    const { getByLabelText, getByText, queryByText } = await renderScreen();

    await act(async () => {
      fireEvent.press(getByLabelText('Today'));
    });

    await waitFor(() => expect(getByText('ship it')).toBeTruthy());
    expect(queryByText('next year')).toBeNull();
  });

  it('adds a task dated today from the Today quick-add', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    mockAddTask.mockImplementation(async (_g, t) => {
      const added = task(t.id, t.text, t.showUpDate);
      mockFetchTasks.mockResolvedValue([added]);
      return added;
    });

    const { getByLabelText, getByText, getByPlaceholderText } =
      await renderScreen();

    await act(async () => {
      fireEvent.press(getByLabelText('Today'));
    });
    await waitFor(() =>
      expect(getByText('Nothing for today. Add a task.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Add a task'));
    });
    const input = getByPlaceholderText('Add a task for today');
    await act(async () => {
      fireEvent.changeText(input, 'call plumber');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('call plumber')).toBeTruthy());
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockAddTask.mock.calls[0][1].text).toBe('call plumber');
    expect(mockAddTask.mock.calls[0][1].showUpDate).toBe(localToday());
  });

  it('completes a task, removing it from Today', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([]);
    mockFetchTasks.mockResolvedValue([task('1', 'ship it', '2020-01-01')]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return {
        ...task('1', 'ship it', '2020-01-01'),
        completedAt: '2023-01-02T00:00:00.000Z',
      };
    });

    const { getByLabelText, getByText, queryByText } = await renderScreen();

    await act(async () => {
      fireEvent.press(getByLabelText('Today'));
    });
    await waitFor(() => expect(getByText('ship it')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Complete "ship it"'));
    });

    await waitFor(() => expect(queryByText('ship it')).toBeNull());
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask.mock.calls[0][1]).toBe('1');
  });
});
