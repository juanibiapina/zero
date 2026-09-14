import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  act,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from '@testing-library/react-native';

import type { Project, ProjectState } from '@/lib/api';
import type { WaitingCondition } from '@zero/agent-core';
import { resetProjectsApiForTest } from '@/lib/projects-collection';
import { resetTasksApiForTest } from '@/lib/tasks-collection';
import { resetWaitsApiForTest } from '@/lib/waits-collection';
import { __resetIconSuggestions } from '@/lib/icon-suggestions';

import ProjectsScreen from '../projects';

// Trigger pull-to-refresh: the scroll host carries the RefreshControl element on
// its `refreshControl` prop (the test renderer exposes host nodes only, so the
// RefreshControl itself is not a queryable node), so invoke that control's
// onRefresh the way a real pull would.
const pullToRefresh = (screen: RenderResult) => {
  const [scroll] = screen.container.queryAll(
    (n) => n.props?.refreshControl != null,
  );
  scroll.props.refreshControl.props.onRefresh();
};

const mockGetToken = jest.fn<() => Promise<string | null>>();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

// The native Clerk button renders a platform view via requireNativeView, which
// is unavailable under jest. Stub it with a queryable element.
jest.mock('@clerk/expo/native', () => ({
  UserButton: () => {
    const { View: V } = require('react-native');
    return <V accessibilityLabel="Account" />;
  },
}));

// A row tap navigates to /projects/:id; capture the push.
const mockPush = jest.fn<(href: string) => void>();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockFetchProjects = jest.fn<() => Promise<Project[]>>();
const mockAddProject =
  jest.fn<
    (
      getToken: unknown,
      project: { id: string; title: string; sourceCaptureId: string | null },
    ) => Promise<Project>
  >();
const mockFetchIconSuggestions =
  jest.fn<
    (
      getToken: unknown,
      input: { title: string; description?: string | null },
    ) => Promise<string[]>
  >();
const mockFetchWaits = jest.fn<() => Promise<WaitingCondition[]>>();
jest.mock('@/lib/api', () => ({
  fetchProjects: () => mockFetchProjects(),
  addProject: (
    getToken: unknown,
    project: { id: string; title: string; sourceCaptureId: string | null },
  ) => mockAddProject(getToken, project),
  fetchIconSuggestions: (
    getToken: unknown,
    input: { title: string; description?: string | null },
  ) => mockFetchIconSuggestions(getToken, input),
  setProjectState: () => Promise.reject(new Error('not used')),
  editProject: () => Promise.reject(new Error('not used')),
  deleteProject: () => Promise.resolve(),
  // Projects loads tasks/waits/captures for derivation and the refine banner; []
  // is enough here.
  fetchWaits: () => mockFetchWaits(),
  addWaitingCondition: () => Promise.reject(new Error('not used')),
  resolveWaitingCondition: () => Promise.reject(new Error('not used')),
  deleteWaitingCondition: () => Promise.resolve(),
  fetchTasks: () => Promise.resolve([]),
  addTask: () => Promise.reject(new Error('not used')),
  completeTask: () => Promise.reject(new Error('not used')),
}));

const project = (
  id: string,
  title: string,
  icon = '📁',
  state: ProjectState = 'in-play',
): Project => ({
  id,
  title,
  icon,
  description: null,
  state,
  createdAt: '2023-01-01T00:00:00.000Z',
});

const renderScreen = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProjectsScreen />
    </QueryClientProvider>,
  );
};

describe('ProjectsScreen (list)', () => {
  beforeEach(() => {
    resetProjectsApiForTest();
    resetTasksApiForTest();
    resetWaitsApiForTest();
    mockPush.mockReset();
    mockAddProject.mockClear();
    mockFetchProjects.mockReset();
    mockFetchProjects.mockResolvedValue([]);
    __resetIconSuggestions();
    mockFetchIconSuggestions.mockReset();
    mockFetchIconSuggestions.mockResolvedValue(['🌟']);
    mockFetchWaits.mockReset();
    mockFetchWaits.mockResolvedValue([]);
  });

  it('shows the fetched projects with their icons', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃')]);

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText('Run a 5K')).toBeTruthy());
    expect(getByText('🏃')).toBeTruthy();
  });

  it('navigates to the project screen when a row is tapped', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃')]);

    const { getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Run a 5K')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Run a 5K'));
    });

    expect(mockPush).toHaveBeenCalledWith('/projects/1');
  });

  it('shows the empty state when there are no projects', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([]);

    const { getByText } = await renderScreen();

    await waitFor(() =>
      expect(getByText('No projects yet. Name your first outcome.')).toBeTruthy(),
    );
  });

  it('surfaces a load error when there is nothing to show', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockRejectedValue(new Error('java.net.UnknownHostException'));

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText(/UnknownHostException/)).toBeTruthy());
  });

  it('creates a project by name and closes the quick-add after adding', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([]);
    mockAddProject.mockImplementation(async () => {
      const added = project('2', 'Have a baby');
      mockFetchProjects.mockResolvedValue([added]);
      return added;
    });

    const { getByText, getByLabelText, getByPlaceholderText, queryByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(getByText('No projects yet. Name your first outcome.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('New project'));
    });

    const input = getByPlaceholderText('Name an outcome');
    await act(async () => {
      fireEvent.changeText(input, 'Have a baby');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('Have a baby')).toBeTruthy());
    expect(mockAddProject).toHaveBeenCalledTimes(1);
    expect(mockAddProject.mock.calls[0][1].title).toBe('Have a baby');
    await waitFor(() =>
      expect(queryByPlaceholderText('Name an outcome')).toBeNull(),
    );
    // Creating a project pre-warms icon suggestions in the background off the
    // title alone (create is name-only).
    await waitFor(() =>
      expect(mockFetchIconSuggestions).toHaveBeenCalledTimes(1),
    );
    expect(mockFetchIconSuggestions.mock.calls[0][1]).toEqual({
      title: 'Have a baby',
      description: null,
    });
    // Creating a project opens its own screen right away. The id is the
    // client-minted UUID on the optimistic row (not the mock's server id), so
    // match the route shape rather than a fixed id.
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        expect.stringMatching(/^\/projects\/.+/),
      ),
    );
  });

  it('protects a project draft until discard is confirmed', async () => {
    mockGetToken.mockResolvedValue('tok');
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByLabelText('New project')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('New project'));
    await fireEvent.changeText(screen.getByLabelText('New item text'), 'Keep this draft');
    await fireEvent.press(screen.getByLabelText('Dismiss quick add'));
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Cancel'));
    expect(screen.getByLabelText('New item text').props.value).toBe('Keep this draft');
    await fireEvent.press(screen.getByLabelText('Dismiss quick add'));
    await fireEvent.press(screen.getByLabelText('Discard'));
    expect(screen.queryByLabelText('New item text')).toBeNull();
    expect(mockAddProject).not.toHaveBeenCalled();
  });

  it('shows a Project pill when the quick-add bar is open', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([]);

    const { getByLabelText, queryByLabelText } = await renderScreen();

    // The pill is absent while the bar is collapsed.
    expect(queryByLabelText('Add a project')).toBeNull();

    await act(async () => {
      fireEvent.press(getByLabelText('New project'));
    });

    // Opening the bar reveals the single Project mode pill, reading like Home's.
    await waitFor(() => expect(getByLabelText('Add a project')).toBeTruthy());
  });

  it('groups projects under a status section header', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃')]);

    const { getByLabelText } = await renderScreen();

    await waitFor(() => expect(getByLabelText('Next, 1')).toBeTruthy());
  });

  it('badges each waiting project with how long it has waited, longest-first', async () => {
    mockGetToken.mockResolvedValue('tok');
    // Both are 'next' with an open condition and no tasks, so both derive to
    // waiting. "Older wait" has the earlier condition (waited longer) and must
    // sort above "Newer wait".
    mockFetchProjects.mockResolvedValue([
      project('1', 'Newer wait'),
      project('2', 'Older wait'),
    ]);
    const wait = (
      id: string,
      projectId: string,
      createdAt: string,
    ): WaitingCondition => ({
      id,
      projectId,
      kind: 'free-text',
      text: 'blocked',
      refId: null,
      targetStatus: null,
      resolvedAt: null,
      createdAt,
    });
    mockFetchWaits.mockResolvedValue([
      wait('cA', '1', '2024-06-01T00:00:00.000Z'),
      wait('cB', '2', '2023-01-01T00:00:00.000Z'),
    ]);

    const { getByText, getAllByLabelText, getAllByText } = await renderScreen();

    await waitFor(() => expect(getByText('Older wait')).toBeTruthy());
    // Both rows carry a "Waiting …" badge.
    expect(getAllByLabelText(/^Waiting /)).toHaveLength(2);
    // Longest wait on top: "Older wait" renders before "Newer wait".
    const titles = getAllByText(/ wait$/).map((n) => n.props.children);
    expect(titles).toEqual(['Older wait', 'Newer wait']);
  });

  it('re-pulls the projects when the list is pulled to refresh', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃')]);

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('Run a 5K')).toBeTruthy());

    const before = mockFetchProjects.mock.calls.length;
    await act(async () => {
      pullToRefresh(screen);
    });

    await waitFor(() =>
      expect(mockFetchProjects.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
