import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { defaultToastController, type Project, type ProjectAttention, type Task } from '@zero/agent-core';

import {
  createInMemoryTodoData,
  InMemoryTodoDataProvider,
  type InMemoryTodoSeed,
} from '@/testing/in-memory-todo-data';

import HomeScreen from '../index';

const mockNavigate = jest.fn<(href: string, options?: unknown) => void>();
jest.mock('expo-router', () => ({
  router: { navigate: (href: string, options?: unknown) => mockNavigate(href, options) },
}));
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: async () => 'token' }),
  useUser: () => ({ user: null }),
}));

const task = (id: string, text: string, over: Partial<Task> = {}): Task => ({
  id,
  text,
  createdAt: '2026-09-01T00:00:00.000Z',
  completedAt: null,
  showUpDate: null,
  recurrence: null,
  recurrenceDate: null,
  projectId: null,
  sortKey: null,
  ...over,
});
const project = (id: string, title: string, over: Partial<Project> = {}): Project => ({
  id,
  title,
  icon: '🎓',
  description: null,
  state: 'in-play',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});
const after = (projectId: string, refId: string): ProjectAttention => ({
  id: 'after',
  projectId,
  kind: 'project-status',
  text: null,
  refId,
  targetStatus: 'done',
  resolvedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
});

async function renderScreen(seed: InMemoryTodoSeed = {}, guest = false) {
  const data = createInMemoryTodoData(seed);
  if (guest) {
    data.workspaceStatus = 'guest';
    data.signedIn = false;
    data.connected = false;
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <InMemoryTodoDataProvider data={data}>
        <HomeScreen />
      </InMemoryTodoDataProvider>
    </QueryClientProvider>,
  );
  return { ...screen, data };
}

describe('HomeScreen', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    defaultToastController.dismiss();
  });

  it('shows the empty account call to action', async () => {
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('Create your first project')).toBeTruthy());
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByLabelText('Account')).toBeTruthy();
  });

  it('labels guest work as saved on this device', async () => {
    const screen = await renderScreen({}, true);
    await waitFor(() => expect(screen.getByText('Saved on this device')).toBeTruthy());
    expect(screen.queryByText('Offline · saved on this device')).toBeNull();
  });

  it('shows arrived project work even when the project has an unresolved After relationship', async () => {
    const screen = await renderScreen({
      projects: [project('p', 'Diploma')],
      tasks: [task('t', 'pack boxes', { projectId: 'p', showUpDate: '2026-09-01' })],
      waits: [after('p', 'missing-prerequisite')],
    });
    await waitFor(() => expect(screen.getByText('pack boxes')).toBeTruthy());
    expect(screen.getByText('🎓')).toBeTruthy();
  });

  it('adds a loose task through the screen API', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText('Task'));
    const input = screen.getByPlaceholderText('Add a task');
    await fireEvent.changeText(input, 'call the dentist');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.getByText('call the dentist')).toBeTruthy());
    expect([...screen.data.replica!.tasks.collection.values()][0]).toMatchObject({
      text: 'call the dentist',
      projectId: null,
    });
  });

  it('parses recurring quick-add text into the stored task', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText('Task'));
    const input = screen.getByPlaceholderText('Add a task');
    await fireEvent.changeText(input, 'stand up every day');
    expect(screen.getByTestId('schedule-highlight', { includeHiddenElements: true }).props.children)
      .toBe('every day');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.getByText('stand up')).toBeTruthy());
    expect([...screen.data.replica!.tasks.collection.values()][0]?.recurrence?.pattern).toEqual({
      unit: 'day',
      interval: 1,
    });
  });

  it('completes and restores a task through Undo', async () => {
    const screen = await renderScreen({ tasks: [task('t', 'mail the letter')] });
    await waitFor(() => expect(screen.getByText('mail the letter')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Complete "mail the letter"'));
    await waitFor(() => expect(screen.queryByText('mail the letter')).toBeNull());

    const toast = defaultToastController.getSnapshot()[0];
    expect(toast?.message).toBe('Completed');
    await act(async () => toast?.action?.onPress());
    await waitFor(() => expect(screen.getByText('mail the letter')).toBeTruthy());
    expect(screen.data.replica!.tasks.collection.get('t')?.completedAt).toBeNull();
  });

  it('edits a task through its detail sheet', async () => {
    const screen = await renderScreen({ tasks: [task('t', 'buy milk')] });
    await waitFor(() => expect(screen.getByText('buy milk')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Edit "buy milk"'));
    const input = screen.getByDisplayValue('buy milk');
    await fireEvent.changeText(input, 'buy oat milk');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.getByText('buy oat milk')).toBeTruthy());
    expect(screen.data.replica!.tasks.collection.get('t')?.text).toBe('buy oat milk');
  });

  it('moves a postponed Home task out of the visible list', async () => {
    const screen = await renderScreen({ tasks: [task('t', 'buy milk')] });
    await waitFor(() => expect(screen.getByText('buy milk')).toBeTruthy());
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

    await waitFor(() => expect(screen.queryByText('buy milk')).toBeNull());
    expect(screen.data.replica!.tasks.collection.get('t')?.showUpDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });
});
