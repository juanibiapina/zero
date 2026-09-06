import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  act,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from '@testing-library/react-native';

import type { Project, ProjectStatus } from '@/lib/api';
import { resetProjectsApiForTest } from '@/lib/projects-collection';
import { resetTasksApiForTest } from '@/lib/tasks-collection';
import { resetWaitsApiForTest } from '@/lib/waits-collection';
import { resetCapturesApiForTest } from '@/lib/captures-collection';

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
    (getToken: unknown, project: { id: string; title: string }) => Promise<Project>
  >();
jest.mock('@/lib/api', () => ({
  fetchProjects: () => mockFetchProjects(),
  addProject: (getToken: unknown, project: { id: string; title: string }) =>
    mockAddProject(getToken, project),
  setProjectStatus: () => Promise.reject(new Error('not used')),
  editProject: () => Promise.reject(new Error('not used')),
  deleteProject: () => Promise.resolve(),
  // Projects loads tasks/waits/captures for derivation and the refine banner; []
  // is enough here.
  fetchWaits: () => Promise.resolve([]),
  addWaitingCondition: () => Promise.reject(new Error('not used')),
  resolveWaitingCondition: () => Promise.reject(new Error('not used')),
  deleteWaitingCondition: () => Promise.resolve(),
  fetchCaptures: () => Promise.resolve([]),
  addCapture: () => Promise.reject(new Error('not used')),
  processCapture: () => Promise.reject(new Error('not used')),
  editCapture: () => Promise.reject(new Error('not used')),
  rescheduleCapture: () => Promise.reject(new Error('not used')),
  reorderCapture: () => Promise.reject(new Error('not used')),
  fetchTasks: () => Promise.resolve([]),
  addTask: () => Promise.reject(new Error('not used')),
  completeTask: () => Promise.reject(new Error('not used')),
  setTaskTakenOn: () => Promise.reject(new Error('not used')),
}));

const project = (
  id: string,
  title: string,
  icon = '📁',
  status: ProjectStatus = 'next',
): Project => ({
  id,
  title,
  icon,
  description: null,
  status,
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
    resetCapturesApiForTest();
    mockPush.mockReset();
    mockAddProject.mockClear();
    mockFetchProjects.mockReset();
    mockFetchProjects.mockResolvedValue([]);
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

  it('creates a project by name and keeps the input open and cleared', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([]);
    mockAddProject.mockImplementation(async () => {
      const added = project('2', 'Have a baby');
      mockFetchProjects.mockResolvedValue([added]);
      return added;
    });

    const { getByText, getByLabelText, getByPlaceholderText } = await renderScreen();

    await waitFor(() =>
      expect(getByText('No projects yet. Name your first outcome.')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('New project'));
    });

    const input = getByPlaceholderText('Run a 5K under 30 min');
    await act(async () => {
      fireEvent.changeText(input, 'Have a baby');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('Have a baby')).toBeTruthy());
    expect(mockAddProject).toHaveBeenCalledTimes(1);
    expect(mockAddProject.mock.calls[0][1].title).toBe('Have a baby');
    expect(getByPlaceholderText('Run a 5K under 30 min').props.value).toBe('');
  });

  it('groups projects under a status section header', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃', 'next')]);

    const { getByLabelText } = await renderScreen();

    await waitFor(() => expect(getByLabelText('Next, 1')).toBeTruthy());
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
