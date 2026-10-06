import { localToday } from '@zero/agent-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
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
const waiting = (projectId: string, id = `waiting-${projectId}`): ProjectAttention => ({
  id,
  projectId,
  kind: 'free-text',
  text: 'a reply',
  refId: null,
  targetStatus: null,
  resolvedAt: null,
  createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
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

  it('shows a quiet no-project state without duplicating the add action', async () => {
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('Home is clear')).toBeTruthy());
    expect(screen.getByText('Nothing needs your attention right now.')).toBeTruthy();
    expect(screen.getByText('No projects yet')).toBeTruthy();
    expect(screen.getByText(
      'Projects group related tasks around an outcome you want to accomplish.',
    )).toBeTruthy();
    expect(screen.queryByText('Create a project')).toBeNull();
    expect(screen.getByLabelText('Add')).toBeTruthy();
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByLabelText('Account')).toBeTruthy();
  });

  it('shows every Next and Waiting project without previewing After or Backlog', async () => {
    const nextOne = project('next-1', 'Finish diploma');
    const nextTwo = project('next-2', 'Move apartment');
    const waitingOne = project('waiting-1', 'Hear from the landlord');
    const waitingTwo = project('waiting-2', 'Receive the certificate');
    const afterOnly = project('after-only', 'Plan the celebration');
    const prerequisite = project('prerequisite', 'Prerequisite');
    const backlog = project('backlog', 'Learn the piano', { state: 'backlog' });
    const screen = await renderScreen({
      projects: [
        nextOne,
        nextTwo,
        waitingOne,
        waitingTwo,
        afterOnly,
        prerequisite,
        backlog,
      ],
      waits: [
        waiting(waitingOne.id),
        waiting(waitingTwo.id),
        after(afterOnly.id, prerequisite.id),
      ],
    });

    await waitFor(() => expect(screen.getByText('Home is clear')).toBeTruthy());
    expect(screen.getByRole('header', { name: 'Next' })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Waiting' })).toBeTruthy();
    expect(screen.getByText('Finish diploma')).toBeTruthy();
    expect(screen.getByText('Move apartment')).toBeTruthy();
    expect(screen.getByText('Hear from the landlord')).toBeTruthy();
    expect(screen.getByText('Receive the certificate')).toBeTruthy();
    expect(screen.getAllByText(/^for /)).toHaveLength(2);
    expect(screen.queryByLabelText('Plan the celebration')).toBeNull();
    expect(screen.getByLabelText('Prerequisite')).toBeTruthy();
    expect(screen.queryByLabelText('Learn the piano')).toBeNull();
    expect(screen.getByLabelText('View all projects')).toBeTruthy();
  });

  it('opens a previewed project and the full Projects tab', async () => {
    const screen = await renderScreen({
      projects: [project('p', 'Finish diploma')],
    });
    await waitFor(() => expect(screen.getByLabelText('Finish diploma')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Finish diploma'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p', { withAnchor: true });

    await fireEvent.press(screen.getByLabelText('View all projects'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects', undefined);
  });

  it('keeps the clear state out of the normal Home task list', async () => {
    const screen = await renderScreen({ tasks: [task('t', 'mail the letter')] });
    await waitFor(() => expect(screen.getByText('mail the letter')).toBeTruthy());
    expect(screen.queryByText('Home is clear')).toBeNull();
    expect(screen.queryByText('No projects yet')).toBeNull();
  });

  it('distinguishes completed Project history from a fresh workspace', async () => {
    const screen = await renderScreen({
      projects: [project('done', 'Finished outcome')],
    });
    await waitFor(() => expect(screen.getByText('Finished outcome')).toBeTruthy());
    await act(async () => {
      await screen.data.replica!.projects.setState('done', 'done').isPersisted.promise;
    });
    await waitFor(() => expect(screen.getByText('No current projects')).toBeTruthy());
    expect(screen.getByText(
      'Start another whenever you have a new outcome to work toward.',
    )).toBeTruthy();
    expect(screen.queryByText('No projects yet')).toBeNull();
    expect(screen.queryByLabelText('View all projects')).toBeNull();
  });

  it('keeps the guest Home header quiet', async () => {
    const screen = await renderScreen({}, true);
    expect(screen.queryByLabelText('Saved on this device')).toBeNull();
    expect(screen.queryByTestId('sync-status-icon-frame')).toBeNull();
    expect(screen.getByLabelText('Account')).toBeTruthy();
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
    await fireEvent.press(screen.getByLabelText('Add'));
    const input = screen.getByPlaceholderText('Add a task');
    await fireEvent.changeText(input, 'call the dentist');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.getByText('call the dentist')).toBeTruthy());
    expect([...screen.data.replica!.tasks.collection.values()][0]).toMatchObject({
      text: 'call the dentist',
      projectId: null,
    });
  });

  it('adds Waiting for a completed task\'s project, then offers only Task and Project from Add', async () => {
    const screen = await renderScreen({
      projects: [project('p', 'Run a 5K')],
      tasks: [task('t', 'register for the race', { projectId: 'p', showUpDate: '2026-09-01' })],
    });
    await waitFor(() => expect(screen.getByText('register for the race')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Complete "register for the race"'));

    const toast = defaultToastController.getSnapshot()[0];
    expect(toast?.secondaryAction?.label).toBe('Waiting…');
    await act(async () => toast?.secondaryAction?.onPress());
    const input = await waitFor(() => screen.getByLabelText('Waiting on'));
    expect(screen.getByLabelText('Project Run a 5K')).toBeTruthy();
    await fireEvent.changeText(input, 'the bib arrives');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.queryByLabelText('Waiting on')).toBeNull());
    expect([...screen.data.replica!.waits.collection.values()]).toMatchObject([
      { projectId: 'p', text: 'the bib arrives' },
    ]);

    await fireEvent.press(screen.getByLabelText('Add'));
    expect(screen.getByPlaceholderText('Add a task')).toBeTruthy();
    expect(screen.getByLabelText('Add a project')).toBeTruthy();
    expect(screen.queryByLabelText('Add a waiting condition')).toBeNull();
    expect(screen.queryByLabelText('Add an After project')).toBeNull();
  });

  it('closes an empty quick-add editor when the keyboard starts hiding', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText('Add'));
    expect(screen.getByPlaceholderText('Add a task')).toBeTruthy();

    await act(async () => {
      (global as typeof globalThis & {
        __emitKeyboardEvent: (name: string) => void;
      }).__emitKeyboardEvent('keyboardWillHide');
    });

    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Add a task')).toBeNull(),
    );
    expect(screen.getByLabelText('Add')).toBeTruthy();
  });

  it('asks before discarding a quick-add draft when the keyboard starts hiding', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText('Add'));
    await fireEvent.changeText(
      screen.getByPlaceholderText('Add a task'),
      'keep this draft',
    );

    await act(async () => {
      (global as typeof globalThis & {
        __emitKeyboardEvent: (name: string) => void;
      }).__emitKeyboardEvent('keyboardWillHide');
    });

    expect(await screen.findByText('Discard changes?')).toBeTruthy();
    expect(screen.getByDisplayValue('keep this draft')).toBeTruthy();
  });

  it('keeps independent Task and Project drafts when switching creation modes', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText('Add'));
    await fireEvent.changeText(screen.getByPlaceholderText('Add a task'), 'Call tomorrow');
    await fireEvent.press(screen.getByLabelText('Add a project'));
    await fireEvent.changeText(screen.getByPlaceholderText('Name an outcome'), 'Read every day');
    expect(screen.queryByTestId('schedule-highlight', { includeHiddenElements: true })).toBeNull();
    await fireEvent.press(screen.getByLabelText('Add a task'));
    expect(screen.getByDisplayValue('Call tomorrow')).toBeTruthy();
    expect(screen.getByTestId('schedule-highlight', { includeHiddenElements: true }).props.children).toBe('tomorrow');
    await fireEvent.press(screen.getByLabelText('Add a project'));
    expect(screen.getByDisplayValue('Read every day')).toBeTruthy();
  });

  it('parses recurring quick-add text into the stored task', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText('Add'));
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

  it('shows recurrence and the next occurrence, then restores it with Undo', async () => {
    const today = localToday();
    const recurring = { ...task('r', 'Water plants'), showUpDate: today, recurrenceDate: today,
      recurrence: { version: 1 as const, origin: today, anchor: 'scheduled' as const, weekStartsOn: 'MO' as const, pattern: { unit: 'day' as const, interval: 1 } } };
    const screen = await renderScreen({ tasks: [recurring] });
    expect(await screen.findByText('Every day')).toBeTruthy();
    expect(screen.getByLabelText('Edit "Water plants", Every day')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Complete "Water plants"'));
    const toast = defaultToastController.getSnapshot()[0];
    expect(toast.message).toBe('Completed · Next: Tomorrow');
    await act(async () => toast.action!.onPress());
    expect(await screen.findByText('Every day')).toBeTruthy();
    expect(screen.data.replica!.tasks.collection.get('r')).toMatchObject(recurring);
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

  it('recognizes a recurrence in an existing task and retains it through completion and Undo', async () => {
    const screen = await renderScreen({ tasks: [task('t', 'Water plants')] });
    await fireEvent.press(await screen.findByLabelText('Edit "Water plants"'));
    const input = screen.getByDisplayValue('Water plants');
    await fireEvent.changeText(input, 'Water plants every day');
    expect(screen.getByTestId('schedule-highlight', { includeHiddenElements: true }).props.children).toBe('every day');
    await fireEvent.press(screen.getByLabelText('Complete task'));
    const toast = defaultToastController.getSnapshot()[0];
    expect(toast.message).toBe('Completed · Next: Tomorrow');
    await act(async () => toast.action!.onPress());
    expect(screen.data.replica!.tasks.collection.get('t')).toMatchObject({ text: 'Water plants', recurrenceDate: localToday(), completedAt: null, recurrence: { pattern: { unit: 'day', interval: 1 } } });
  });

  it('saves a typed date as a one-off postpone of a recurring task', async () => {
    const recurrence = { version: 1 as const, origin: localToday(), anchor: 'scheduled' as const, weekStartsOn: 'MO' as const, pattern: { unit: 'day' as const, interval: 1 } };
    const screen = await renderScreen({ tasks: [task('t', 'Call', { recurrence, recurrenceDate: localToday(), showUpDate: localToday() })] });
    await fireEvent.press(await screen.findByLabelText('Edit "Call", Every day'));
    const input = screen.getByDisplayValue('Call');
    await fireEvent.changeText(input, 'Call tomorrow at 3pm');
    expect(screen.getByTestId('schedule-highlight', { includeHiddenElements: true }).props.children).toBe('tomorrow');
    expect(within(screen.getByTestId('task-schedule')).getByText('Tomorrow')).toBeTruthy();
    await fireEvent(input, 'submitEditing');
    expect(screen.data.replica!.tasks.collection.get('t')).toMatchObject({ text: 'Call at 3pm', recurrence, recurrenceDate: localToday() });
    expect(screen.data.replica!.tasks.collection.get('t')!.showUpDate! > localToday()).toBe(true);
  });

  it('dismisses edit phrases without clearing the existing schedule', async () => {
    const before = task('t', 'Work', { showUpDate: localToday() });
    const screen = await renderScreen({ tasks: [before] });
    await fireEvent.press(await screen.findByLabelText('Edit "Work"'));
    const input = screen.getByDisplayValue('Work');
    await fireEvent.changeText(input, 'Work today tomorrow');
    await fireEvent.press(screen.getByLabelText('Keep schedule words in task title'));
    expect(screen.getByTestId('schedule-highlight', { includeHiddenElements: true }).props.children).toBe('today');
    await fireEvent.press(screen.getByLabelText('Keep schedule words in task title'));
    expect(screen.queryByTestId('schedule-highlight', { includeHiddenElements: true })).toBeNull();
    await fireEvent(input, 'submitEditing');
    expect(screen.data.replica!.tasks.collection.get('t')).toMatchObject({ text: 'Work today tomorrow', showUpDate: before.showUpDate, recurrence: null });
  });

  it('leaves stored schedule words literal when opening and closing an unchanged task', async () => {
    const screen = await renderScreen({ tasks: [task('t', 'Review every day')] });
    await fireEvent.press(await screen.findByLabelText('Edit "Review every day"'));
    expect(screen.queryByTestId('schedule-highlight', { includeHiddenElements: true })).toBeNull();
    await fireEvent(screen.getByDisplayValue('Review every day'), 'submitEditing');
    expect(screen.data.replica!.tasks.collection.get('t')).toMatchObject({ text: 'Review every day', recurrence: null });
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

describe('HomeScreen project suggestions', () => {
  const fetchMock = jest.fn<typeof fetch>();
  const suggestionCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/tasks/project-suggestion'));

  beforeEach(() => {
    defaultToastController.dismiss();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ projectId: 'bathroom' }), { status: 200 }),
    );
    global.fetch = fetchMock;
  });

  it('suggests a Project while typing and files the Task there', async () => {
    const screen = await renderScreen({
      projects: [project('bathroom', 'Bathroom renovation', { icon: '🛁' })],
      tasks: [task('t', 'choose tiles', { projectId: 'bathroom' })],
    });
    await fireEvent.press(screen.getByLabelText('Add'));
    const input = screen.getByPlaceholderText('Add a task');
    await fireEvent.changeText(input, 'buy grout');

    await waitFor(() =>
      expect(screen.getByLabelText('Bathroom renovation, Suggested')).toBeTruthy(),
    );
    const [, init] = suggestionCalls().at(-1)!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      title: 'buy grout',
      projects: [{ id: 'bathroom', tasks: ['choose tiles'] }],
    });

    await fireEvent(input, 'submitEditing');
    await waitFor(() =>
      expect(
        [...screen.data.replica!.tasks.collection.values()].find((row) => row.text === 'buy grout'),
      ).toMatchObject({ projectId: 'bathroom' }),
    );
  });

  it('sends no suggestion request for a guest', async () => {
    const screen = await renderScreen(
      { projects: [project('bathroom', 'Bathroom renovation')] },
      true,
    );
    await fireEvent.press(screen.getByLabelText('Add'));
    await fireEvent.changeText(screen.getByPlaceholderText('Add a task'), 'buy grout');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    expect(suggestionCalls()).toHaveLength(0);
  });
});
