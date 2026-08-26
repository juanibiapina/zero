import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import type { Todo } from '@/lib/api';

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

const mockFetchTodos = jest.fn<(getToken: unknown) => Promise<Todo[]>>();
const mockAddTodo =
  jest.fn<(getToken: unknown, text: string) => Promise<Todo>>();
const mockMarkTodoDone =
  jest.fn<(getToken: unknown, id: string) => Promise<Todo>>();
jest.mock('@/lib/api', () => ({
  fetchTodos: (getToken: unknown) => mockFetchTodos(getToken),
  addTodo: (getToken: unknown, text: string) => mockAddTodo(getToken, text),
  markTodoDone: (getToken: unknown, id: string) =>
    mockMarkTodoDone(getToken, id),
}));

import HomeScreen from '../index';

const todo = (id: string, text: string): Todo => ({
  id,
  text,
  createdAt: '2023-01-01T00:00:00.000Z',
  doneAt: null,
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
  it('shows a loading state until the first fetch settles', async () => {
    mockGetToken.mockResolvedValue('tok');
    let resolveFetch!: (todos: Todo[]) => void;
    mockFetchTodos.mockReturnValue(
      new Promise<Todo[]>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { getByText, queryByText } = await renderScreen();

    // Fetch is still pending: loading shown, empty message NOT shown.
    expect(getByText('Loading your todos…')).toBeTruthy();
    expect(queryByText('No todos yet. Add one above.')).toBeNull();

    await act(async () => {
      resolveFetch([]);
    });

    await waitFor(() =>
      expect(getByText('No todos yet. Add one above.')).toBeTruthy(),
    );
    expect(queryByText('Loading your todos…')).toBeNull();
  });

  it('shows the account button instead of a sign-out button', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);

    const { getByLabelText, queryByText } = await renderScreen();

    expect(getByLabelText('Account')).toBeTruthy();
    expect(queryByText('Sign out')).toBeNull();
  });

  it('surfaces a load error when there is nothing to show', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockRejectedValue(new Error('java.net.UnknownHostException'));

    const { getByText } = await renderScreen();

    await waitFor(() =>
      expect(getByText(/UnknownHostException/)).toBeTruthy(),
    );
  });

  it('shows the fetched todos', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([todo('1', 'buy milk')]);

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
  });

  it('marks a todo done, removing it from the list', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([todo('1', 'buy milk')]);
    mockMarkTodoDone.mockResolvedValue({
      ...todo('1', 'buy milk'),
      doneAt: '2023-01-02T00:00:00.000Z',
    });

    const { getByText, getByLabelText, queryByText } = await renderScreen();

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Mark "buy milk" done'));
    });

    await waitFor(() => expect(queryByText('buy milk')).toBeNull());
    expect(mockMarkTodoDone).toHaveBeenCalledTimes(1);
    expect(mockMarkTodoDone.mock.calls[0][1]).toBe('1');
  });

  it('opens the quick-add input only after tapping the add button', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);

    const { getByLabelText, queryByPlaceholderText } = await renderScreen();

    await waitFor(() =>
      expect(queryByPlaceholderText('Add a todo')).toBeNull(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Add todo'));
    });

    expect(queryByPlaceholderText('Add a todo')).toBeTruthy();
  });

  it('adds a typed todo and keeps the input open and cleared for the next one', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);
    mockAddTodo.mockResolvedValue(todo('2', 'call mom'));

    const { getByText, getByLabelText, getByPlaceholderText } = await renderScreen();

    // Let the initial (empty) load settle before typing, else it can clobber
    // the just-added item.
    await waitFor(() =>
      expect(getByText('No todos yet. Add one above.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Add todo'));
    });

    const input = getByPlaceholderText('Add a todo');
    await act(async () => {
      fireEvent.changeText(input, 'call mom');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('call mom')).toBeTruthy());
    expect(mockAddTodo).toHaveBeenCalledTimes(1);
    expect(mockAddTodo.mock.calls[0][1]).toBe('call mom');

    // The quick-add input stays open and cleared for rapid capture.
    const reopened = getByPlaceholderText('Add a todo');
    expect(reopened.props.value).toBe('');
  });

  it('confirms before discarding unsaved quick-add text', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);

    const { getByLabelText, getByText, getByPlaceholderText, queryByText } =
      await renderScreen();

    await waitFor(() =>
      expect(getByText('No todos yet. Add one above.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Add todo'));
    });
    const input = getByPlaceholderText('Add a todo');
    await act(async () => {
      fireEvent.changeText(input, 'buy milk');
    });

    // Tapping the backdrop with unsaved text opens the confirm dialog and does
    // NOT clear/close the bar.
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });
    expect(getByText('Discard changes?')).toBeTruthy();
    expect(getByPlaceholderText('Add a todo').props.value).toBe('buy milk');

    // Cancel keeps editing: dialog gone, text preserved.
    await act(async () => {
      fireEvent.press(getByLabelText('Cancel'));
    });
    expect(queryByText('Discard changes?')).toBeNull();
    expect(getByPlaceholderText('Add a todo').props.value).toBe('buy milk');
  });

  it('discards the quick-add text when confirming', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);

    const { getByLabelText, getByText, getByPlaceholderText, queryByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(getByText('No todos yet. Add one above.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Add todo'));
    });
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('Add a todo'), 'buy milk');
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Discard'));
    });

    expect(queryByPlaceholderText('Add a todo')).toBeNull();
  });

  it('closes the empty quick-add when the keyboard hides (Android back)', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);

    const { getByLabelText, getByText, getByPlaceholderText, queryByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(getByText('No todos yet. Add one above.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Add todo'));
    });
    expect(getByPlaceholderText('Add a todo')).toBeTruthy();

    // Android's first Back only hides the keyboard; the empty bar must close.
    await act(async () => {
      (
        globalThis as { __emitKeyboardEvent?: (name: string) => void }
      ).__emitKeyboardEvent?.('keyboardDidHide');
    });

    expect(queryByPlaceholderText('Add a todo')).toBeNull();
  });

  it('confirms instead of closing when the keyboard hides with unsaved text', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);

    const { getByLabelText, getByText, getByPlaceholderText } = await renderScreen();

    await waitFor(() =>
      expect(getByText('No todos yet. Add one above.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Add todo'));
    });
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('Add a todo'), 'buy milk');
    });

    await act(async () => {
      (
        globalThis as { __emitKeyboardEvent?: (name: string) => void }
      ).__emitKeyboardEvent?.('keyboardDidHide');
    });

    // Unsaved text: the dialog appears, the bar stays open.
    expect(getByText('Discard changes?')).toBeTruthy();
    expect(getByPlaceholderText('Add a todo').props.value).toBe('buy milk');
  });

  it('closes the quick-add silently when it is empty', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);

    const { getByLabelText, getByText, queryByText, queryByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(getByText('No todos yet. Add one above.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Add todo'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });

    expect(queryByText('Discard changes?')).toBeNull();
    expect(queryByPlaceholderText('Add a todo')).toBeNull();
  });
});
