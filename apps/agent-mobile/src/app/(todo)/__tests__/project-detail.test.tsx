import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Pressable, Text as RNText, View } from 'react-native';
import { defaultToastController, type Project, type ProjectAttention, type Task } from '@zero/agent-core';

import {
  createInMemoryTodoData,
  InMemoryTodoDataProvider,
  type InMemoryTodoSeed,
} from '@/testing/in-memory-todo-data';

import ProjectDetailScreen from '../projects/[id]';

let mockCurrentId = '1';
const mockBack = jest.fn();
const mockNavigate = jest.fn<(href: string, options?: unknown) => void>();
const mockPush = jest.fn<(href: string) => void>();
function mockUseFocusEffect(effect: () => void | (() => void)) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(effect, [effect]);
}
jest.mock('expo-router', () => ({
  router: { navigate: (href: string, options?: unknown) => mockNavigate(href, options) },
  useFocusEffect: mockUseFocusEffect,
  useLocalSearchParams: () => ({ id: mockCurrentId }),
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: async () => 'token' }),
}));

function MockEmojiKeyboard() {
  return <View accessibilityLabel="Manual emoji picker" />;
}
jest.mock('rn-emoji-keyboard', () => ({
  EmojiKeyboard: MockEmojiKeyboard,
}));

function MockView({ children }: { children?: ReactNode }) {
  return <View>{children}</View>;
}
function MockText({ children }: { children?: ReactNode }) {
  return <RNText>{children}</RNText>;
}
function MockButton({ label, onPress }: { label: string; onPress?: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
    <RNText>{label}</RNText>
  </Pressable>;
}
function MockIcon() { return <View />; }
MockIcon.select = () => 'mock-icon';
function MockListItem({ children, onPress }: { children?: ReactNode; onPress?: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress}>{children}</Pressable>;
}
function MockBottomSheet({ isPresented, children }: { isPresented?: boolean; children?: ReactNode }) {
  return isPresented ? <View>{children}</View> : null;
}
jest.mock('@expo/ui', () => ({
  Host: MockView,
  Column: MockView,
  Row: MockView,
  Text: MockText,
  Button: MockButton,
  Icon: MockIcon,
  ListItem: MockListItem,
  BottomSheet: MockBottomSheet,
}));
function MockMenuView({
  actions,
  onPressAction,
  children,
}: {
  actions: { id?: string; title: string }[];
  onPressAction?: (event: { nativeEvent: { event: string } }) => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <View>
    <Pressable onPress={() => setOpen(true)}>{children}</Pressable>
    {open && actions.map((action) => <Pressable
      key={action.id ?? action.title}
      accessibilityRole="button"
      onPress={() => {
        setOpen(false);
        onPressAction?.({ nativeEvent: { event: action.id ?? action.title } });
      }}
    ><RNText>{action.title}</RNText></Pressable>)}
  </View>;
}
jest.mock('@expo/ui/community/menu', () => ({ __esModule: true, MenuView: MockMenuView }));

const project = (id: string, title: string, over: Partial<Project> = {}): Project => ({
  id,
  title,
  icon: '📁',
  description: null,
  state: 'in-play',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});
const task = (id: string, text: string, over: Partial<Task> = {}): Task => ({
  id,
  text,
  showUpDate: '2026-09-01',
  recurrence: null,
  recurrenceDate: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  completedAt: null,
  projectId: '1',
  sortKey: null,
  ...over,
});
const waiting = (): ProjectAttention => ({
  id: 'wait',
  projectId: '1',
  kind: 'free-text',
  text: 'the letter comes back',
  refId: null,
  targetStatus: null,
  resolvedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
});
const after = (): ProjectAttention => ({
  id: 'after',
  projectId: '1',
  kind: 'project-status',
  text: null,
  refId: '2',
  targetStatus: 'done',
  resolvedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
});

async function renderScreen(seed: InMemoryTodoSeed = {}, guest = false) {
  const data = createInMemoryTodoData({ projects: [project('1', 'Run a 5K')], ...seed });
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
        <ProjectDetailScreen />
      </InMemoryTodoDataProvider>
    </QueryClientProvider>,
  );
  return { ...screen, data };
}

describe('ProjectDetailScreen', () => {
  beforeEach(() => {
    mockCurrentId = '1';
    mockBack.mockReset();
    mockNavigate.mockReset();
    mockPush.mockReset();
    defaultToastController.dismiss();
  });

  it('saves the focused project title before returning to projects', async () => {
    const screen = await renderScreen();
    const input = await waitFor(() => screen.getByLabelText('Project title'));
    await fireEvent.changeText(input, '  Run a marathon  ');
    mockBack.mockImplementationOnce(() => {
      expect(screen.data.replica!.projects.collection.get('1')?.title).toBe('Run a marathon');
    });

    await fireEvent.press(screen.getByLabelText('Back to projects'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    await fireEvent(input, 'blur');
    await waitFor(() => expect(screen.getByDisplayValue('Run a marathon')).toBeTruthy());
  });

  it('restores a blank title when returning to projects', async () => {
    const screen = await renderScreen();
    const input = await waitFor(() => screen.getByLabelText('Project title'));
    await fireEvent.changeText(input, '   ');

    await fireEvent.press(screen.getByLabelText('Back to projects'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(screen.data.replica!.projects.collection.get('1')?.title).toBe('Run a 5K');
    expect(screen.getByDisplayValue('Run a 5K')).toBeTruthy();
  });

  it('keeps an untouched title current while editing the description', async () => {
    const screen = await renderScreen();
    const input = await waitFor(() => screen.getByLabelText('Project description'));
    await fireEvent.changeText(input, 'Finish a community race');
    await act(async () => {
      await screen.data.replica!.projects.edit('1', { title: 'Run a marathon' }).isPersisted.promise;
    });
    await waitFor(() => expect(screen.getByDisplayValue('Run a marathon')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Back to projects'));

    expect(screen.data.replica!.projects.collection.get('1')).toMatchObject({
      title: 'Run a marathon', description: 'Finish a community race',
    });
  });

  it('edits the project description through the screen API', async () => {
    const screen = await renderScreen();
    const input = await waitFor(() => screen.getByLabelText('Project description'));
    await fireEvent.changeText(input, 'Finish a community race');
    await fireEvent(input, 'blur');

    await waitFor(() => expect(screen.data.replica!.projects.collection.get('1')?.description)
      .toBe('Finish a community race'));
  });

  it('keeps the manual icon picker but hides account-only suggestions for guests', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const screen = await renderScreen({}, true);
    await waitFor(() => expect(screen.getByLabelText('Change icon')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Change icon'));

    await waitFor(() => expect(screen.getByLabelText('Manual emoji picker')).toBeTruthy());
    expect(screen.queryByLabelText('Suggested icons')).toBeNull();
    expect(screen.queryByLabelText('Refresh suggested icons')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('shows project tasks in manual order', async () => {
    const screen = await renderScreen({
      tasks: [task('b', 'Banana', { sortKey: 'a1' }), task('a', 'Apple', { sortKey: 'a0' })],
    });
    await waitFor(() => expect(screen.getAllByLabelText(/^Edit "/)).toHaveLength(2));
    expect(screen.getAllByLabelText(/^Edit "/).map((row) => row.props.accessibilityLabel)).toEqual([
      'Edit "Apple", scheduled Today',
      'Edit "Banana", scheduled Today',
    ]);
  });

  it('adds a task to the current project', async () => {
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByLabelText('Project title')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Add'));
    const input = screen.getByPlaceholderText('Add a task');
    await fireEvent.changeText(input, 'buy running shoes');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.getByText('buy running shoes')).toBeTruthy());
    expect([...screen.data.replica!.tasks.collection.values()][0]?.projectId).toBe('1');
  });

  it('adds a Waiting item from the completed task snackbar', async () => {
    const screen = await renderScreen({ tasks: [task('t', 'register for the race')] });
    await waitFor(() => expect(screen.getByText('register for the race')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Complete "register for the race"'));

    const toast = defaultToastController.getSnapshot()[0];
    expect(toast?.description).toBe('📁 Run a 5K');
    expect(toast?.secondaryAction?.label).toBe('Waiting…');
    await act(async () => toast?.secondaryAction?.onPress());
    const input = await waitFor(() => screen.getByLabelText('Waiting on'));
    await fireEvent.changeText(input, 'the bib arrives');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.getByText('the bib arrives')).toBeTruthy());
    expect([...screen.data.replica!.waits.collection.values()].map((wait) => wait.text)).toEqual(['the bib arrives']);
  });

  it('resolves a Waiting item immediately', async () => {
    const screen = await renderScreen({ waits: [waiting()] });
    await waitFor(() => expect(screen.getByText('the letter comes back')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Resolve condition: the letter comes back'));

    await waitFor(() => expect(screen.queryByText('the letter comes back')).toBeNull());
    expect(screen.data.replica!.waits.collection.get('wait')?.resolvedAt).not.toBeNull();
  });

  it('opens and removes an After relationship through its public controls', async () => {
    const screen = await renderScreen({
      projects: [project('1', 'Move house'), project('2', 'Sell old house', { icon: '🏠' })],
      waits: [after()],
    });
    await waitFor(() => expect(screen.getByText('After · 🏠 Sell old house')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Open project Sell old house'));
    expect(mockPush).toHaveBeenCalledWith('/projects/2');
    await fireEvent.press(screen.getByLabelText('Remove After relationship with Sell old house'));
    await waitFor(() => expect(screen.queryByText('After')).toBeNull());
    expect(screen.data.replica!.waits.collection.get('after')).toBeUndefined();
  });

  it('moves the project to backlog from its status sheet', async () => {
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByLabelText('Project status: Next')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Project status: Next'));
    await fireEvent.press(screen.getByText('Move to backlog'));

    await waitFor(() => expect(screen.data.replica!.projects.collection.get('1')?.state).toBe('backlog'));
  });

  it('marks the project done and offers Undo', async () => {
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByLabelText('Project status: Next')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Project status: Next'));
    await fireEvent.press(screen.getByText('Mark done'));

    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(screen.data.replica!.projects.collection.get('1')?.state).toBe('done');
    const toast = defaultToastController.getSnapshot()[0];
    expect(toast?.message).toBe('Project completed');
    await act(async () => toast?.action?.onPress());
    await waitFor(() => expect(screen.data.replica!.projects.collection.get('1')?.state).toBe('in-play'));
  });

  it('deletes a project with unblurred title and description drafts without editing it afterward', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderScreen();
    const input = await waitFor(() => screen.getByLabelText('Project description'));
    await fireEvent.changeText(screen.getByLabelText('Project title'), 'Unsaved title');
    await fireEvent.changeText(input, 'Unsaved description');
    await fireEvent.press(screen.getByLabelText('Project settings'));
    await fireEvent.press(screen.getByText('Delete project'));
    const confirm = alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Delete');
    expect(confirm).toBeDefined();
    await act(async () => confirm!.onPress!());
    expect(screen.data.replica!.projects.collection.get('1')).toBeUndefined();
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('This project is no longer here.')).toBeNull();
    expect(screen.getByLabelText('Project title')).toBeTruthy();
    await screen.unmount();
    alert.mockRestore();
  });

  it('offers a way back when the project no longer exists', async () => {
    mockCurrentId = 'missing';
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('This project is no longer here.')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Back to projects'));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
