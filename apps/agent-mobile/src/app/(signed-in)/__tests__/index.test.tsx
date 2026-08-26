import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { Todo } from '@/lib/api';

const mockGetToken = jest.fn<() => Promise<string | null>>();
const mockSignOut = jest.fn();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: mockGetToken, signOut: mockSignOut }),
}));

const mockFetchTodos = jest.fn<(getToken: unknown) => Promise<Todo[]>>();
const mockAddTodo =
  jest.fn<(getToken: unknown, text: string) => Promise<Todo>>();
jest.mock('@/lib/api', () => ({
  fetchTodos: (getToken: unknown) => mockFetchTodos(getToken),
  addTodo: (getToken: unknown, text: string) => mockAddTodo(getToken, text),
}));

import HomeScreen from '../index';

const todo = (id: string, text: string): Todo => ({
  id,
  text,
  createdAt: '2023-01-01T00:00:00.000Z',
});

describe('HomeScreen', () => {
  it('shows a loading state until the first fetch settles', async () => {
    mockGetToken.mockResolvedValue('tok');
    let resolveFetch!: (todos: Todo[]) => void;
    mockFetchTodos.mockReturnValue(
      new Promise<Todo[]>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { getByText, queryByText } = await render(<HomeScreen />);

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

  it('shows the fetched todos', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([todo('1', 'buy milk')]);

    const { getByText } = await render(<HomeScreen />);

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
  });

  it('opens the quick-add input only after tapping the add button', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);

    const { getByLabelText, queryByPlaceholderText } = await render(
      <HomeScreen />,
    );

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

    const { getByText, getByLabelText, getByPlaceholderText } = await render(
      <HomeScreen />,
    );

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
});
