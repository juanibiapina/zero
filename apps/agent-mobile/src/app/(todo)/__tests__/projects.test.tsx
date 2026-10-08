import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { type Project, type ProjectAttention } from '@zero/agent-core';

import { __resetIconSuggestions } from '@/lib/icon-suggestions';
import {
  createInMemoryTodoData,
  InMemoryTodoDataProvider,
  type InMemoryTodoSeed,
} from '@/testing/in-memory-todo-data';

import ProjectsScreen from '../projects';

const mockPush = jest.fn<(href: string) => void>();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: async () => 'token' }),
  useUser: () => ({ user: null }),
}));

function MockEmojiKeyboard({ onEmojiSelected }: { onEmojiSelected: (picked: { emoji: string }) => void }) {
  const { Pressable } = jest.requireActual<typeof import('react-native')>('react-native');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Pick 🎓"
      onPress={() => onEmojiSelected({ emoji: '🎓' })}
    />
  );
}
jest.mock('rn-emoji-keyboard', () => ({ EmojiKeyboard: MockEmojiKeyboard }));

const project = (id: string, title: string, over: Partial<Project> = {}): Project => ({
  id,
  title,
  icon: '📁',
  description: null,
  state: 'in-play',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});
const waiting = (id: string, projectId: string, createdAt: string): ProjectAttention => ({
  id,
  projectId,
  kind: 'free-text',
  text: 'External reply',
  refId: null,
  targetStatus: null,
  resolvedAt: null,
  createdAt,
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
        <ProjectsScreen />
      </InMemoryTodoDataProvider>
    </QueryClientProvider>,
  );
  return { ...screen, data };
}

describe('ProjectsScreen', () => {
  beforeEach(async () => {
    mockPush.mockReset();
    __resetIconSuggestions();
    await AsyncStorage.clear();
  });

  it('shows projects and navigates through a row', async () => {
    const screen = await renderScreen({ projects: [project('p', 'Run a 5K', { icon: '🏃' })] });
    await waitFor(() => expect(screen.getByText('Run a 5K')).toBeTruthy());
    expect(screen.getByText('🏃')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Run a 5K'));
    expect(mockPush).toHaveBeenCalledWith('/projects/p');
  });

  it('shows the empty state when every Project is done', async () => {
    const screen = await renderScreen({ projects: [project('p', 'Run a 5K', { state: 'done' })] });
    await waitFor(() =>
      expect(screen.getByText('No projects yet. Name your first outcome.')).toBeTruthy());
    expect(screen.queryByText('Run a 5K')).toBeNull();
  });

  it('shows the empty state', async () => {
    const screen = await renderScreen();
    await waitFor(() =>
      expect(screen.getByText('No projects yet. Name your first outcome.')).toBeTruthy());
  });

  it('creates a project and opens it', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText('Add'));
    const input = screen.getByPlaceholderText('Name an outcome');
    await fireEvent.changeText(input, 'Have a baby');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.getByText('Have a baby')).toBeTruthy());
    const created = [...screen.data.replica!.projects.collection.values()][0];
    expect(created?.title).toBe('Have a baby');
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/projects/${created?.id}`));
  });

  describe('icon suggestions while typing', () => {
    let icons: string[] = [];
    const respond = async () => new Response(JSON.stringify({ icons }), { status: 200 });
    const createdIcon = (screen: Awaited<ReturnType<typeof renderScreen>>, title: string) =>
      [...screen.data.replica!.projects.collection.values()].find((item) => item.title === title)?.icon;

    it('creates the Project with the top suggestion', async () => {
      icons = ['🌟', '🚀'];
      const fetch = jest.spyOn(global, 'fetch').mockImplementation(respond);
      const screen = await renderScreen();
      await fireEvent.press(screen.getByLabelText('Add'));
      const input = screen.getByPlaceholderText('Name an outcome');
      await fireEvent.changeText(input, 'Run a 5K');

      await waitFor(() =>
        expect(screen.getByLabelText('Use icon 🌟').props.accessibilityState).toMatchObject({ selected: true }),
      );
      await fireEvent(input, 'submitEditing');

      await waitFor(() => expect(createdIcon(screen, 'Run a 5K')).toBe('🌟'));
      fetch.mockRestore();
    });

    it('keeps a picked icon while suggestions keep updating', async () => {
      icons = ['🌟', '🚀'];
      const fetch = jest.spyOn(global, 'fetch').mockImplementation(respond);
      const screen = await renderScreen();
      await fireEvent.press(screen.getByLabelText('Add'));
      const input = screen.getByPlaceholderText('Name an outcome');
      await fireEvent.changeText(input, 'Run a 5K');
      await waitFor(() => expect(screen.getByLabelText('Use icon 🚀')).toBeTruthy());
      await fireEvent.press(screen.getByLabelText('Use icon 🚀'));

      icons = ['🏃', '👟'];
      await fireEvent.changeText(input, 'Run a 5K in May');
      await waitFor(() => expect(screen.getByLabelText('Use icon 🏃')).toBeTruthy());
      expect(screen.getByLabelText('Change icon, 🚀')).toBeTruthy();
      await fireEvent(input, 'submitEditing');

      await waitFor(() => expect(createdIcon(screen, 'Run a 5K in May')).toBe('🚀'));
      fetch.mockRestore();
    });
  });

  it('picks any emoji for a new project from the full picker and keeps the draft', async () => {
    const screen = await renderScreen({}, true);
    await fireEvent.press(screen.getByLabelText('Add'));
    const input = screen.getByPlaceholderText('Name an outcome');
    await fireEvent.changeText(input, 'Graduate');
    await fireEvent.press(screen.getByLabelText('Change icon, 📁'));
    await fireEvent.press(screen.getByLabelText('Pick 🎓'));

    expect(screen.getByLabelText('Change icon, 🎓')).toBeTruthy();
    expect(screen.getByPlaceholderText('Name an outcome').props.value).toBe('Graduate');
    await fireEvent(screen.getByPlaceholderText('Name an outcome'), 'submitEditing');
    await waitFor(() =>
      expect([...screen.data.replica!.projects.collection.values()][0]?.icon).toBe('🎓'),
    );
  });

  it('creates a guest project without requesting account-only icon suggestions', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const screen = await renderScreen({}, true);
    await fireEvent.press(screen.getByLabelText('Add'));
    const input = screen.getByPlaceholderText('Name an outcome');
    await fireEvent.changeText(input, 'Plan locally');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.getByText('Plan locally')).toBeTruthy());
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('creates a loose task from the shared Add surface', async () => {
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText('Add'));
    await fireEvent.press(screen.getByLabelText('Add a task'));
    const input = screen.getByPlaceholderText('Add a task');
    await fireEvent.changeText(input, 'Call the dentist');
    await fireEvent(input, 'submitEditing');

    await waitFor(() => expect(screen.queryByPlaceholderText('Add a task')).toBeNull());
    expect([...screen.data.replica!.tasks.collection.values()][0]).toMatchObject({
      text: 'Call the dentist',
      parent: null,
      showUpDate: null,
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('groups projects by state', async () => {
    const screen = await renderScreen({
      projects: [
        project('next', 'Run a 5K'),
        project('later', 'Write a book', { state: 'backlog' }),
      ],
    });
    await waitFor(() => expect(screen.getByLabelText('Next, 1')).toBeTruthy());
    expect(screen.getByLabelText('Backlog, 1')).toBeTruthy();
  });

  it('starts After and Backlog folded and remembers a fold across restarts', async () => {
    const seed: InMemoryTodoSeed = {
      projects: [
        project('next', 'Run a 5K'),
        project('after', 'Paint the nursery'),
        project('later', 'Write a book', { state: 'backlog' }),
      ],
      waits: [{
        id: 'after-link', projectId: 'after', kind: 'project-status', text: null,
        refId: 'next', targetStatus: 'done', createdAt: '2026-09-01T00:00:00.000Z', resolvedAt: null,
      }],
    };
    const expanded = (screen: Awaited<ReturnType<typeof renderScreen>>, label: string) =>
      screen.getByLabelText(label).props.accessibilityState.expanded;
    const first = await renderScreen(seed);
    await waitFor(() => expect(first.getByLabelText('Backlog, 1')).toBeTruthy());
    expect(expanded(first, 'After, 1')).toBe(false);
    expect(expanded(first, 'Backlog, 1')).toBe(false);
    expect(first.queryByText('Write a book')).toBeNull();
    await fireEvent.press(first.getByLabelText('Backlog, 1'));
    expect(first.getByText('Write a book')).toBeTruthy();
    await waitFor(async () => expect(await AsyncStorage.getAllKeys()).toHaveLength(1));

    const second = await renderScreen(seed);
    await waitFor(() => expect(expanded(second, 'Backlog, 1')).toBe(true));
    expect(second.getByText('Write a book')).toBeTruthy();
    expect(expanded(second, 'After, 1')).toBe(false);
  });

  it('orders waiting projects by the oldest unresolved condition', async () => {
    const screen = await renderScreen({
      projects: [project('new', 'Newer wait'), project('old', 'Older wait')],
      waits: [
        waiting('new-wait', 'new', '2026-09-20T00:00:00.000Z'),
        waiting('old-wait', 'old', '2026-09-10T00:00:00.000Z'),
      ],
    });
    await waitFor(() => expect(screen.getByText('Older wait')).toBeTruthy());
    const labels = screen.getAllByLabelText(/wait$/).map((node) => node.props.accessibilityLabel);
    expect(labels).toEqual(['Older wait', 'Newer wait']);
  });
});
