import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { defaultToastController, type Project, type Task } from '@zero/agent-core';

import {
  createInMemoryTodoData,
  InMemoryTodoDataProvider,
  type InMemoryTodoSeed,
} from '@/testing/in-memory-todo-data';

import UpcomingScreen from '../browse/upcoming';

const mockNavigate = jest.fn<(href: string, options?: unknown) => void>();
jest.mock('expo-router', () => ({
  router: { navigate: (href: string, options?: unknown) => mockNavigate(href, options) },
}));
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: async () => 'token' }),
}));
const mockUserButton = () => <View accessibilityLabel="Account" />;
jest.mock('@clerk/expo/native', () => ({
  UserButton: () => mockUserButton(),
}));

const task = (
  id: string,
  text: string,
  showUpDate: string | null = null,
  projectId: string | null = null,
): Task => ({
  id,
  text,
  createdAt: '2026-09-01T00:00:00.000Z',
  completedAt: null,
  showUpDate,
  recurrence: null,
  recurrenceDate: null,
  projectId,
  sortKey: null,
});
const project = (id: string): Project => ({
  id,
  title: 'Diploma',
  icon: '🎓',
  description: null,
  state: 'in-play',
  createdAt: '2026-09-01T00:00:00.000Z',
});

async function renderScreen(seed: InMemoryTodoSeed = {}) {
  const data = createInMemoryTodoData(seed);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <InMemoryTodoDataProvider data={data}>
        <UpcomingScreen />
      </InMemoryTodoDataProvider>
    </QueryClientProvider>,
  );
  return { ...screen, data };
}

describe('UpcomingScreen', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    defaultToastController.dismiss();
  });

  it('lists future work and hides undated work', async () => {
    const screen = await renderScreen({
      tasks: [task('now', 'undated thought'), task('later', 'ship the release', '2099-01-01')],
    });
    await waitFor(() => expect(screen.getByText('ship the release')).toBeTruthy());
    expect(screen.queryByText('undated thought')).toBeNull();
  });

  it('shows a project icon on linked future work', async () => {
    const screen = await renderScreen({
      projects: [project('p')],
      tasks: [task('later', 'mail the letter', '2099-01-01', 'p')],
    });
    await waitFor(() => expect(screen.getByText('mail the letter')).toBeTruthy());
    expect(screen.getByText('🎓')).toBeTruthy();
  });

  it('completes future work through the screen API', async () => {
    const screen = await renderScreen({ tasks: [task('later', 'ship the release', '2099-01-01')] });
    await waitFor(() => expect(screen.getByText('ship the release')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Complete "ship the release"'));

    await waitFor(() => expect(screen.queryByText('ship the release')).toBeNull());
    expect(screen.data.replica!.tasks.collection.get('later')?.completedAt).not.toBeNull();
  });

  it('edits future work and opens its project', async () => {
    const screen = await renderScreen({
      projects: [project('p')],
      tasks: [task('later', 'ship the release', '2099-01-01', 'p')],
    });
    await waitFor(() => expect(screen.getByText('ship the release')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Edit "ship the release"'));
    const input = screen.getByDisplayValue('ship the release');
    await fireEvent.changeText(input, 'ship the big release');
    await fireEvent(input, 'submitEditing');
    await waitFor(() => expect(screen.getByText('ship the big release')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Edit "ship the big release"'));
    await fireEvent.press(screen.getByLabelText('Open project Diploma'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p', { withAnchor: true });
  });

  it('clears a schedule and moves the task back to Home', async () => {
    const screen = await renderScreen({ tasks: [task('later', 'ship the release', '2099-01-01')] });
    await waitFor(() => expect(screen.getByText('ship the release')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Edit "ship the release"'));
    await fireEvent.press(screen.getByLabelText('Set schedule'));
    await fireEvent.press(screen.getByLabelText('No date'));

    await waitFor(() => expect(screen.queryByText('ship the release')).toBeNull());
    expect(screen.data.replica!.tasks.collection.get('later')?.showUpDate).toBeNull();
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });
});
