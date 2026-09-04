import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import type { Project } from '@/lib/api';
import { resetProjectsApiForTest } from '@/lib/projects-collection';

import ProjectsScreen from '../projects';

const mockGetToken = jest.fn<() => Promise<string | null>>();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

// The native Clerk button renders a platform view via requireNativeView, which
// is unavailable under jest. Stub it with a queryable element.
const mockUserButton = () => <View accessibilityLabel="Account" />;
jest.mock('@clerk/expo/native', () => ({
  UserButton: () => mockUserButton(),
}));

const mockFetchProjects = jest.fn<(getToken: unknown) => Promise<Project[]>>();
const mockAddProject =
  jest.fn<
    (
      getToken: unknown,
      project: { id: string; title: string },
    ) => Promise<Project>
  >();
jest.mock('@/lib/api', () => ({
  fetchProjects: (getToken: unknown) => mockFetchProjects(getToken),
  addProject: (getToken: unknown, project: { id: string; title: string }) =>
    mockAddProject(getToken, project),
}));

const project = (id: string, title: string, icon = '📁'): Project => ({
  id,
  title,
  icon,
  description: null,
  status: 'next',
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

describe('ProjectsScreen', () => {
  beforeEach(() => {
    resetProjectsApiForTest();
    mockAddProject.mockClear();
  });

  it('shows the fetched projects with their icons', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃')]);

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText('Run a 5K')).toBeTruthy());
    expect(getByText('🏃')).toBeTruthy();
  });

  it('shows the empty state when there are no projects', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([]);

    const { getByText } = await renderScreen();

    await waitFor(() =>
      expect(
        getByText('No projects yet. Name your first outcome.'),
      ).toBeTruthy(),
    );
  });

  it('surfaces a load error when there is nothing to show', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockRejectedValue(
      new Error('java.net.UnknownHostException'),
    );

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText(/UnknownHostException/)).toBeTruthy());
  });

  it('opens the name entry only after tapping the add button', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([]);

    const { getByLabelText, queryByPlaceholderText } = await renderScreen();

    await waitFor(() =>
      expect(queryByPlaceholderText('Run a 5K under 30 min')).toBeNull(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('New project'));
    });

    expect(queryByPlaceholderText('Run a 5K under 30 min')).toBeTruthy();
  });

  it('creates a project by name and keeps the input open and cleared', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([]);
    mockAddProject.mockImplementation(async () => {
      const added = project('2', 'Have a baby');
      mockFetchProjects.mockResolvedValue([added]);
      return added;
    });

    const { getByText, getByLabelText, getByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(
        getByText('No projects yet. Name your first outcome.'),
      ).toBeTruthy(),
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

    const reopened = getByPlaceholderText('Run a 5K under 30 min');
    expect(reopened.props.value).toBe('');
  });

  it('does not create a project from an empty name', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([]);

    const { getByText, getByLabelText, getByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(
        getByText('No projects yet. Name your first outcome.'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('New project'));
    });
    const input = getByPlaceholderText('Run a 5K under 30 min');
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    expect(mockAddProject).not.toHaveBeenCalled();
  });
});
