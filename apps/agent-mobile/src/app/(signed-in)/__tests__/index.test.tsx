import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { Todo } from '@/lib/api';

const mockGetToken = jest.fn<() => Promise<string | null>>();
const mockSignOut = jest.fn();
jest.mock('@clerk/clerk-expo', () => ({
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
  it('shows the fetched todos', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([todo('1', 'buy milk')]);

    const { getByText } = await render(<HomeScreen />);

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
  });

  it('adds a typed todo and shows it in the list', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchTodos.mockResolvedValue([]);
    mockAddTodo.mockResolvedValue(todo('2', 'call mom'));

    const { getByText, getByPlaceholderText } = await render(<HomeScreen />);

    // Let the initial (empty) load settle before typing, else it can clobber
    // the just-added item.
    await waitFor(() =>
      expect(getByText('No todos yet. Add one above.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('Add a todo'), 'call mom');
    });
    await act(async () => {
      fireEvent.press(getByText('Add'));
    });

    await waitFor(() => expect(getByText('call mom')).toBeTruthy());
    expect(mockAddTodo).toHaveBeenCalledTimes(1);
    expect(mockAddTodo.mock.calls[0][1]).toBe('call mom');
  });
});
