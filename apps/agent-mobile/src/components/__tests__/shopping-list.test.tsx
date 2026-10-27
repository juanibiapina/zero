import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defaultToastController } from '@zero/agent-core';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, waitFor } from 'expo-router/testing-library';

import BrowseLayout from '@/app/(todo)/browse/_layout';
import BrowseScreen from '@/app/(todo)/browse/index';
import ShoppingListPage from '@/app/(todo)/browse/shopping-list';
import { createInMemoryTodoData, InMemoryTodoDataProvider } from '@/testing/in-memory-todo-data';

jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: async () => 'token', signOut: async () => {} }),
  useUser: () => ({ user: null }),
}));
jest.mock('expo-router/build/testing-library/mocks', () => ({}));
jest.mock('react-native-safe-area-context', () => jest.requireActual<typeof import('react-native-safe-area-context/jest/mock')>('react-native-safe-area-context/jest/mock').default);

declare global {
  var __reorderableOnReorder: ((event: { from: number; to: number }) => void) | undefined;
}

afterEach(() => {
  defaultToastController.dismiss();
});

async function open(initialUrl: string, items: string[] = ['Milk', 'Eggs', 'Bread']) {
  const data = createInMemoryTodoData();
  for (const item of items) await data.replica!.shopping.add(item);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = renderRouter({
    _layout: () => <QueryClientProvider client={client}><InMemoryTodoDataProvider data={data}><Stack screenOptions={{ headerShown: false }} /></InMemoryTodoDataProvider></QueryClientProvider>,
    'browse/_layout': BrowseLayout,
    'browse/index': BrowseScreen,
    'browse/shopping-list': ShoppingListPage,
  }, { initialUrl });
  const texts = () => data.replica!.snapshot().shopping.map((item) => item.text);
  return { screen: await result, result, data, texts };
}

describe('Shopping list', () => {
  it('is listed under Browse', async () => {
    const { screen, result } = await open('/browse');
    await fireEvent.press(screen.getByLabelText('Shopping list'));
    expect(result.getPathname()).toBe('/browse/shopping-list');
    expect(screen.getByText('Milk')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Back to Browse'));
    expect(result.getPathname()).toBe('/browse');
  });

  it('adds an item at the bottom with the + button', async () => {
    const { screen, texts } = await open('/browse/shopping-list');
    await fireEvent.press(screen.getByLabelText('Add'));
    expect(screen.queryByLabelText('Add a task')).toBeNull();
    const input = screen.getByPlaceholderText('Add to shopping list');
    await fireEvent.changeText(input, 'Coffee');
    await fireEvent(input, 'submitEditing');
    await waitFor(() => expect(screen.getByText('Coffee')).toBeTruthy());
    expect(texts()).toEqual(['Milk', 'Eggs', 'Bread', 'Coffee']);
    expect(defaultToastController.getSnapshot()).toEqual([]);
  });

  it('removes a bought item, with Undo', async () => {
    const { screen, texts } = await open('/browse/shopping-list');
    await fireEvent.press(screen.getByLabelText('Mark "Eggs" bought'));
    await waitFor(() => expect(screen.queryByText('Eggs')).toBeNull());

    const toast = defaultToastController.getSnapshot()[0];
    expect(toast?.message).toBe('Bought');
    await act(async () => toast?.action?.onPress());
    await waitFor(() => expect(screen.getByText('Eggs')).toBeTruthy());
    expect(texts()).toEqual(['Milk', 'Eggs', 'Bread']);
  });

  it('reorders items by dragging', async () => {
    const { screen, texts } = await open('/browse/shopping-list');
    expect(screen.getByText('Bread')).toBeTruthy();
    await act(async () => globalThis.__reorderableOnReorder?.({ from: 2, to: 0 }));
    await waitFor(() => expect(texts()).toEqual(['Bread', 'Milk', 'Eggs']));
  });

  it('edits an item in the task sheet without reading dates', async () => {
    const { screen, texts } = await open('/browse/shopping-list');
    await fireEvent.press(screen.getByLabelText('Edit "Milk"'));
    const input = screen.getByLabelText('Item text');
    await fireEvent.changeText(input, 'Oat milk tomorrow');
    expect(screen.queryByTestId('schedule-highlight', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId('task-schedule')).toBeNull();
    await fireEvent(input, 'submitEditing');
    await waitFor(() => expect(screen.getByText('Oat milk tomorrow')).toBeTruthy());
    expect(texts()).toEqual(['Oat milk tomorrow', 'Eggs', 'Bread']);
  });

  it('marks an item bought from its sheet', async () => {
    const { screen, texts } = await open('/browse/shopping-list');
    await fireEvent.press(screen.getByLabelText('Edit "Bread"'));
    await fireEvent.press(screen.getByLabelText('Mark bought'));
    await waitFor(() => expect(texts()).toEqual(['Milk', 'Eggs']));
    expect(defaultToastController.getSnapshot()[0]?.message).toBe('Bought');
  });
});
