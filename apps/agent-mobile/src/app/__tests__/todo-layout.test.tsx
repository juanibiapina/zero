import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, Platform, Text } from 'react-native';

import type { TodoData } from '@/lib/todo-data-context';
import { createInMemoryTodoData } from '@/testing/in-memory-todo-data';

import TodoLayout from '../(todo)/_layout';

const mockUseAuth = jest.fn();
const mockUseTodoData = jest.fn<() => TodoData>();
const mockOnColdStart = jest.fn(async () => {});
const mockOnForeground = jest.fn(async () => {});
const mockCreateSync = jest.fn((_getToken: unknown) => ({
  onColdStart: mockOnColdStart,
  onForeground: mockOnForeground,
}));

jest.mock('@clerk/expo', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('../../lib/timezone-sync', () => ({
  createMobileTimezoneSync: (getToken: unknown) => mockCreateSync(getToken),
}));

jest.mock('../../lib/use-todo-data', () => ({
  useTodoData: () => mockUseTodoData(),
}));

const mockSetAppIcon = jest.fn<(icon: string) => boolean>();
jest.mock('../../../modules/home-app-icon', () => ({
  setHomeAppIcon: (icon: string) => mockSetAppIcon(icon),
}));

function mockTrigger({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
function MockTriggerIcon() { return null; }
function MockTriggerLabel({ children }: { children?: ReactNode }) {
  return <Text>{children}</Text>;
}
function MockTriggerBadge() { return null; }
mockTrigger.Icon = MockTriggerIcon;
mockTrigger.Label = MockTriggerLabel;
mockTrigger.Badge = MockTriggerBadge;
function mockNativeTabs({ children }: { children?: ReactNode }) {
  return <Text>tabs{children}</Text>;
}
mockNativeTabs.Trigger = mockTrigger;
jest.mock('expo-router/unstable-native-tabs', () => ({ NativeTabs: mockNativeTabs }));

let todoData: TodoData;
let renderedLayout: Awaited<ReturnType<typeof render>> | undefined;

async function renderLayout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  renderedLayout = await render(
    <QueryClientProvider client={client}>
      <TodoLayout />
    </QueryClientProvider>,
  );
  return renderedLayout;
}

describe('TodoLayout', () => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockSetAppIcon.mockReset();
    mockSetAppIcon.mockReturnValue(true);
    mockOnColdStart.mockClear();
    mockOnForeground.mockClear();
    mockCreateSync.mockClear();
    todoData = createInMemoryTodoData({ tasks: [{
      id: 'visible', text: 'Visible task', showUpDate: null,
      recurrence: null, recurrenceDate: null,
      createdAt: '2026-09-14T07:00:00.000Z', completedAt: null,
      parent: null, sortKey: null,
    }] });
    mockUseTodoData.mockReturnValue(todoData);
  });

  afterEach(async () => {
    await renderedLayout?.unmount();
    renderedLayout = undefined;
    await todoData.replica?.close();
    jest.restoreAllMocks();
  });

  it('shows a loading indicator until Clerk is loaded', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: false, isSignedIn: false });
    const { toJSON } = await renderLayout();
    expect(JSON.stringify(toJSON())).toContain('ActivityIndicator');
    expect(mockSetAppIcon).not.toHaveBeenCalled();
  });

  it('opens the todo tabs when signed out', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    const { getByText, toJSON } = await renderLayout();
    expect(getByText(/^tabs/)).toBeTruthy();
    expect(JSON.stringify(toJSON())).toMatch(/Home.*Projects.*Browse/);
  });

  it('shows Home, Projects, and Browse in that order without an Upcoming tab', async () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      userId: 'user-test',
      getToken: async () => null,
    });
    const { getByText, queryByText, toJSON } = await renderLayout();
    expect(getByText(/^tabs/)).toBeTruthy();
    expect(JSON.stringify(toJSON())).toMatch(/Home.*Projects.*Browse/);
    expect(queryByText('Upcoming')).toBeNull();
  });

  it('does not sync timezone while signed out', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    await renderLayout();
    expect(mockCreateSync).not.toHaveBeenCalled();
  });

  it.each([false, true])('mirrors the hydrated Home count when signedIn=%s', async (signedIn) => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: signedIn });
    mockUseTodoData.mockReturnValue({
      ...todoData,
      workspaceStatus: signedIn ? 'account' : 'guest',
      signedIn,
    });
    await renderLayout();

    await waitFor(() => expect(mockSetAppIcon).toHaveBeenLastCalledWith('OneTask'));
    expect(mockSetAppIcon).not.toHaveBeenCalledWith('Default');
  });

  it('waits for the workspace before selecting a launcher count', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockUseTodoData.mockReturnValue({
      ...todoData,
      ready: false,
      replica: null,
      workspaceStatus: 'opening',
    });
    const { getByText } = await renderLayout();

    expect(getByText('Opening your saved tasks…')).toBeTruthy();
    expect(mockSetAppIcon).not.toHaveBeenCalled();
  });

  it('reconciles on cold start and on foreground when signed in', async () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      userId: 'user-test',
      getToken: async () => null,
    });
    const spy = jest.spyOn(AppState, 'addEventListener').mockClear();
    await renderLayout();

    expect(mockOnColdStart).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const [, handler] of spy.mock.calls) handler('background');
    });
    expect(mockOnForeground).not.toHaveBeenCalled();
    await act(async () => {
      for (const [, handler] of spy.mock.calls) handler('active');
    });
    expect(mockOnForeground).toHaveBeenCalledTimes(1);
  });
});
