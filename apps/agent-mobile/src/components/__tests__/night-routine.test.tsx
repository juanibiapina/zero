import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defaultToastController } from '@zero/agent-core';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, waitFor } from 'expo-router/testing-library';
import { AppState } from 'react-native';

import HomeScreen from '@/app/(todo)/index';
import BrowseLayout from '@/app/(todo)/browse/_layout';
import BrowseScreen from '@/app/(todo)/browse/index';
import NightRoutinePage from '@/app/(todo)/browse/night-routine';
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
  jest.useRealTimers();
  jest.restoreAllMocks();
  defaultToastController.dismiss();
});

async function open(at: string, initialUrl: string, steps: string[] = ['Shower', 'Meditate']) {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'], now: new Date(at) });
  const data = createInMemoryTodoData();
  for (const step of steps) await data.replica!.nightRoutine.addStep(step);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = renderRouter({
    _layout: () => <QueryClientProvider client={client}><InMemoryTodoDataProvider data={data}><Stack screenOptions={{ headerShown: false }} /></InMemoryTodoDataProvider></QueryClientProvider>,
    index: HomeScreen,
    'browse/_layout': BrowseLayout,
    'browse/index': BrowseScreen,
    'browse/night-routine': NightRoutinePage,
  }, { initialUrl });
  return { screen: await result, result, data };
}

describe('Night routine', () => {
  it('shows the moon on Home from the opening time and opens the routine page', async () => {
    const { screen, result } = await open('2026-10-19T20:59:30', '/');
    expect(screen.queryByLabelText('Night routine')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await fireEvent.press(await waitFor(() => screen.getByLabelText('Night routine')));
    expect(result.getPathname()).toBe('/browse/night-routine');
    expect(screen.getByText('Shower')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Back to Home'));
    expect(result.getPathname()).toBe('/');
  });

  it('shows the moon when the app returns after the opening time', async () => {
    const appState = jest.spyOn(AppState, 'addEventListener');
    const { screen } = await open('2026-10-19T20:00:00', '/');
    expect(screen.queryByLabelText('Night routine')).toBeNull();
    jest.setSystemTime(new Date('2026-10-19T21:30:00'));
    await act(async () => {
      for (const [event, listener] of appState.mock.calls) if (event === 'change') (listener as (state: string) => void)('active');
    });
    expect(screen.getByLabelText('Night routine')).toBeTruthy();
  });

  it('is listed under Browse at any time', async () => {
    const { screen, result } = await open('2026-10-19T14:00:00', '/browse');
    await fireEvent.press(screen.getByLabelText('Night routine'));
    expect(result.getPathname()).toBe('/browse/night-routine');
    expect(screen.getByText('Shower')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Back to Browse'));
    expect(result.getPathname()).toBe('/browse');
  });

  it('adds a step with the + button', async () => {
    const { screen, data } = await open('2026-10-19T21:00:00', '/browse/night-routine', []);
    expect(screen.getByText('Add the steps of your night routine')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Add'));
    expect(screen.queryByLabelText('Task')).toBeNull();
    const input = screen.getByPlaceholderText('Add a step');
    await fireEvent.changeText(input, 'Wechseldusche on legs');
    await fireEvent(input, 'submitEditing');
    await waitFor(() => expect(screen.getByText('Wechseldusche on legs')).toBeTruthy());
    expect(data.replica!.snapshot().nights[0]?.steps.map((step) => step.text)).toEqual(['Wechseldusche on legs']);
  });

  it('moves a completed step to Done tonight, with Undo', async () => {
    const { screen } = await open('2026-10-19T21:10:00', '/browse/night-routine');
    await fireEvent.press(screen.getByLabelText('Complete "Shower"'));
    await waitFor(() => expect(screen.queryByLabelText('Complete "Shower"')).toBeNull());
    await fireEvent.press(screen.getByLabelText('Done tonight, 1'));
    expect(screen.getByText('21:10')).toBeTruthy();

    const toast = defaultToastController.getSnapshot()[0];
    expect(toast?.message).toBe('Shower done');
    await act(async () => toast?.action?.onPress());
    await waitFor(() => expect(screen.getByLabelText('Complete "Shower"')).toBeTruthy());
  });

  it('ends the night on Going to bed and leaves undone steps undone', async () => {
    const { screen } = await open('2026-10-19T23:42:00', '/browse/night-routine');
    await fireEvent.press(screen.getByLabelText('Complete "Meditate"'));
    await waitFor(() => expect(screen.queryByLabelText('Complete "Meditate"')).toBeNull());
    await fireEvent.press(screen.getByLabelText('Going to bed'));
    await waitFor(() => expect(screen.getByText('Good night · 1 of 2 done · bed at 23:42')).toBeTruthy());
    expect(screen.queryByLabelText('Complete "Shower"')).toBeNull();
    expect(screen.queryByLabelText('Add')).toBeNull();

    const toast = defaultToastController.getSnapshot()[0];
    await act(async () => toast?.action?.onPress());
    await waitFor(() => expect(screen.getByLabelText('Complete "Shower"')).toBeTruthy());
  });

  it('renames and removes a step', async () => {
    const { screen } = await open('2026-10-19T21:00:00', '/browse/night-routine');
    await fireEvent.press(screen.getByLabelText('Edit "Shower"'));
    await fireEvent.changeText(screen.getByLabelText('Step'), 'Leg shower');
    await fireEvent.press(screen.getByLabelText('Save step'));
    await waitFor(() => expect(screen.getByText('Leg shower')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Edit "Meditate"'));
    await fireEvent.press(screen.getByLabelText('Remove step'));
    await waitFor(() => expect(screen.queryByLabelText('Edit "Meditate"')).toBeNull());
  });

  it('reorders open steps by dragging', async () => {
    const { screen, data } = await open('2026-10-19T21:00:00', '/browse/night-routine', ['A', 'B', 'C']);
    await act(async () => { globalThis.__reorderableOnReorder?.({ from: 2, to: 0 }); });
    await waitFor(() => expect(data.replica!.snapshot().nights[0]?.steps.map((step) => step.text)).toEqual(['C', 'A', 'B']));
    expect(screen.getAllByLabelText(/^Edit "/).map((row) => row.props.accessibilityLabel)).toEqual(['Edit "C"', 'Edit "A"', 'Edit "B"']);
  });
});
