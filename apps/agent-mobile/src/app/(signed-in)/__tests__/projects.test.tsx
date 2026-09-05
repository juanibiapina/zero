import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  Pressable,
  Text as RNText,
  TextInput as RNTextInput,
  View,
} from 'react-native';

import type { Project, ProjectEditFields, ProjectStatus, Task } from '@/lib/api';
import { resetProjectsApiForTest } from '@/lib/projects-collection';
import { resetTasksApiForTest } from '@/lib/tasks-collection';
import { resetWaitsApiForTest } from '@/lib/waits-collection';
import type { WaitingCondition } from '@/lib/api';

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

// The detail sheet renders a native @expo/ui tree (Column/Row/Button/TextInput
// inside a native BottomSheet), which does not run under jest-expo: `Row`
// resolves undefined, `TextInput` reaches for an absent native module, and the
// native views need a device. Substitute faithful RN passthroughs for the six
// controls the sheet uses so its wiring is unit-testable; the real native
// controls are verified on-device (Maestro). `Button` exposes its label as the
// accessibility name, so label-based queries match the real control; the mock
// `BottomSheet` renders its children only when presented, like the real sheet.
// Each mock is a hoisted `Mock`-prefixed component (jest permits a mock factory
// to reference those) so its JSX lives at module scope, not inside the hoisted
// factory where a React reference would be out of scope.
function MockView({ children }: { children?: ReactNode }) {
  return <View>{children}</View>;
}
function MockText({ children }: { children?: ReactNode }) {
  return <RNText>{children}</RNText>;
}
function MockButton({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
      <RNText>{label}</RNText>
    </Pressable>
  );
}
function MockTextInput({
  value,
  defaultValue,
  onChangeText,
  onBlur,
  onSubmitEditing,
  placeholder,
}: {
  value?: string;
  defaultValue?: string;
  onChangeText?: (t: string) => void;
  onBlur?: () => void;
  onSubmitEditing?: () => void;
  placeholder?: string;
}) {
  return (
    <RNTextInput
      value={value ?? defaultValue}
      onChangeText={onChangeText}
      onBlur={onBlur}
      onSubmitEditing={onSubmitEditing}
      placeholder={placeholder}
    />
  );
}
function MockBottomSheet({
  isPresented,
  children,
}: {
  isPresented?: boolean;
  children?: ReactNode;
}) {
  return isPresented ? <View>{children}</View> : null;
}
jest.mock('@expo/ui', () => ({
  Host: MockView,
  Column: MockView,
  Row: MockView,
  Text: MockText,
  Button: MockButton,
  TextInput: MockTextInput,
  BottomSheet: MockBottomSheet,
}));

const mockFetchProjects = jest.fn<(getToken: unknown) => Promise<Project[]>>();
const mockAddProject =
  jest.fn<
    (
      getToken: unknown,
      project: { id: string; title: string },
    ) => Promise<Project>
  >();
const mockSetProjectStatus =
  jest.fn<
    (getToken: unknown, id: string, status: ProjectStatus) => Promise<Project>
  >();
const mockEditProject =
  jest.fn<
    (getToken: unknown, id: string, fields: ProjectEditFields) => Promise<Project>
  >();
const mockDeleteProject =
  jest.fn<(getToken: unknown, id: string) => Promise<void>>();
const mockFetchTasks = jest.fn<(getToken: unknown) => Promise<Task[]>>();
const mockAddTask =
  jest.fn<
    (
      getToken: unknown,
      task: { id: string; text: string; showUpDate: string; projectId: string | null },
    ) => Promise<Task>
  >();
const mockCompleteTask =
  jest.fn<(getToken: unknown, id: string) => Promise<Task>>();
const mockFetchWaits = jest.fn<() => Promise<WaitingCondition[]>>();
const mockAddWaitingCondition =
  jest.fn<
    (condition: {
      id: string;
      projectId: string;
      kind: string;
      text: string | null;
      refId: string | null;
      targetStatus: string | null;
    }) => Promise<WaitingCondition>
  >();
const mockResolveWaitingCondition =
  jest.fn<(id: string) => Promise<WaitingCondition>>();
jest.mock('@/lib/api', () => ({
  fetchProjects: (getToken: unknown) => mockFetchProjects(getToken),
  addProject: (getToken: unknown, project: { id: string; title: string }) =>
    mockAddProject(getToken, project),
  setProjectStatus: (getToken: unknown, id: string, status: ProjectStatus) =>
    mockSetProjectStatus(getToken, id, status),
  editProject: (getToken: unknown, id: string, fields: ProjectEditFields) =>
    mockEditProject(getToken, id, fields),
  deleteProject: (getToken: unknown, id: string) =>
    mockDeleteProject(getToken, id),
  fetchWaits: () => mockFetchWaits(),
  addWaitingCondition: (
    _getToken: unknown,
    condition: {
      id: string;
      projectId: string;
      kind: string;
      text: string | null;
      refId: string | null;
      targetStatus: string | null;
    },
  ) => mockAddWaitingCondition(condition),
  resolveWaitingCondition: (_getToken: unknown, id: string) =>
    mockResolveWaitingCondition(id),
  deleteWaitingCondition: () => Promise.resolve(),
  fetchTasks: (getToken: unknown) => mockFetchTasks(getToken),
  addTask: (
    getToken: unknown,
    task: { id: string; text: string; showUpDate: string; projectId: string | null },
  ) => mockAddTask(getToken, task),
  completeTask: (getToken: unknown, id: string) => mockCompleteTask(getToken, id),
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

describe('ProjectsScreen', () => {
  beforeEach(() => {
    resetProjectsApiForTest();
    resetTasksApiForTest();
    resetWaitsApiForTest();
    mockFetchWaits.mockReset();
    mockFetchWaits.mockResolvedValue([]);
    mockAddWaitingCondition.mockReset();
    mockResolveWaitingCondition.mockReset();
    mockAddProject.mockClear();
    mockSetProjectStatus.mockClear();
    mockEditProject.mockClear();
    mockDeleteProject.mockClear();
    mockAddTask.mockReset();
    mockCompleteTask.mockReset();
    mockFetchTasks.mockReset();
    mockFetchTasks.mockResolvedValue([]);
  });

  it('adds a task to a project from its detail sheet', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃', 'next')]);
    mockAddTask.mockImplementation(async (_t, task) => {
      const added: Task = {
        id: task.id,
        text: task.text,
        showUpDate: task.showUpDate,
        createdAt: '2023-01-01T00:00:00.000Z',
        completedAt: null,
        projectId: task.projectId,
        takenOnAt: null,
      };
      mockFetchTasks.mockResolvedValue([added]);
      return added;
    });

    const { getByText, getByLabelText, getByPlaceholderText } =
      await renderScreen();
    await waitFor(() => expect(getByText('Run a 5K')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Run a 5K'));
    });
    const input = getByPlaceholderText('Add a task to this project…');
    await act(async () => {
      fireEvent.changeText(input, 'buy running shoes');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() =>
      expect(getByLabelText('Complete "buy running shoes"')).toBeTruthy(),
    );
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockAddTask.mock.calls[0][1].projectId).toBe('1');
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

  it('groups projects under a status section header', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃', 'next')]);

    const { getByLabelText } = await renderScreen();

    await waitFor(() => expect(getByLabelText('Next, 1')).toBeTruthy());
  });

  it('adds a free-text waiting condition, marking the project Waiting', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([
      project('1', 'Send tax letter', '📮', 'next'),
    ]);
    mockAddWaitingCondition.mockImplementation(async (condition) => {
      const added: WaitingCondition = {
        ...condition,
        kind: condition.kind as WaitingCondition['kind'],
        resolvedAt: null,
        createdAt: '2023-01-01T00:00:00.000Z',
      };
      mockFetchWaits.mockResolvedValue([added]);
      return added;
    });

    const { getByText, getByLabelText, getByPlaceholderText } =
      await renderScreen();
    await waitFor(() => expect(getByText('Send tax letter')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Send tax letter'));
    });
    const input = getByPlaceholderText(
      'Waiting on… (e.g. the letter comes back)',
    );
    await act(async () => {
      fireEvent.changeText(input, 'the letter comes back');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    expect(mockAddWaitingCondition).toHaveBeenCalledTimes(1);
    expect(mockAddWaitingCondition.mock.calls[0][0].text).toBe(
      'the letter comes back',
    );
    // The project moves to the Waiting section.
    await waitFor(() => expect(getByLabelText('Waiting, 1')).toBeTruthy());
  });

  it('moves a project to backlog from the detail sheet', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃', 'next')]);
    mockSetProjectStatus.mockImplementation(async (_t, id, status) => {
      const updated = project('1', 'Run a 5K', '🏃', status);
      mockFetchProjects.mockResolvedValue([updated]);
      return updated;
    });

    const { getByText, getByLabelText } = await renderScreen();

    await waitFor(() => expect(getByText('Run a 5K')).toBeTruthy());

    // Tap the row to open the detail sheet, then park it to Backlog.
    await act(async () => {
      fireEvent.press(getByLabelText('Run a 5K'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Move to backlog'));
    });

    expect(mockSetProjectStatus).toHaveBeenCalledTimes(1);
    expect(mockSetProjectStatus.mock.calls[0][1]).toBe('1');
    expect(mockSetProjectStatus.mock.calls[0][2]).toBe('backlog');
    await waitFor(() => expect(getByLabelText('Backlog, 1')).toBeTruthy());
  });

  it('changes a project icon from the detail sheet', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃', 'next')]);
    mockEditProject.mockImplementation(async (_t, id, fields) => {
      const updated = project('1', 'Run a 5K', fields.icon ?? '🏃', 'next');
      mockFetchProjects.mockResolvedValue([updated]);
      return updated;
    });

    const { getByText, getByLabelText } = await renderScreen();

    await waitFor(() => expect(getByText('Run a 5K')).toBeTruthy());

    // Open the sheet, then pick a new icon from the curated picker.
    await act(async () => {
      fireEvent.press(getByLabelText('Run a 5K'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('🎓'));
    });

    expect(mockEditProject).toHaveBeenCalledTimes(1);
    expect(mockEditProject.mock.calls[0][1]).toBe('1');
    expect(mockEditProject.mock.calls[0][2]).toEqual({ icon: '🎓' });
  });

  it('defers Done behind an Undo and does not commit when undone', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃', 'next')]);

    const { getByText, getByLabelText, queryByLabelText } = await renderScreen();

    await waitFor(() => expect(getByText('Run a 5K')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Run a 5K'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Mark done'));
    });

    // The row is held with an Undo affordance; nothing is written yet.
    await waitFor(() => expect(getByLabelText('Undo')).toBeTruthy());
    expect(mockSetProjectStatus).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(getByLabelText('Undo'));
    });

    // Undone: no write ever fires and the row is tappable again.
    expect(mockSetProjectStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByLabelText('Undo')).toBeNull());
    expect(getByLabelText('Run a 5K')).toBeTruthy();
  });

  it('defers Delete behind an Undo and does not commit when undone', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃', 'next')]);

    const { getByText, getByLabelText, queryByLabelText } = await renderScreen();

    await waitFor(() => expect(getByText('Run a 5K')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Run a 5K'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Delete project'));
    });

    // The row is held with an Undo affordance; nothing is deleted yet.
    await waitFor(() => expect(getByLabelText('Undo')).toBeTruthy());
    expect(mockDeleteProject).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(getByLabelText('Undo'));
    });

    // Undone: no delete ever fires and the row is tappable again.
    expect(mockDeleteProject).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByLabelText('Undo')).toBeNull());
    expect(getByLabelText('Run a 5K')).toBeTruthy();
  });

  it('commits Delete after the undo window elapses', async () => {
    jest.useFakeTimers();
    try {
      mockGetToken.mockResolvedValue('tok');
      mockFetchProjects.mockResolvedValue([
        project('1', 'Run a 5K', '🏃', 'next'),
      ]);
      mockDeleteProject.mockImplementation(async () => {
        mockFetchProjects.mockResolvedValue([]);
      });

      const { getByLabelText } = await renderScreen();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.press(getByLabelText('Run a 5K'));
      });
      await act(async () => {
        fireEvent.press(getByLabelText('Delete project'));
      });

      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });

      expect(mockDeleteProject).toHaveBeenCalledTimes(1);
      expect(mockDeleteProject.mock.calls[0][1]).toBe('1');
    } finally {
      jest.useRealTimers();
    }
  });

  it('commits Done after the undo window elapses', async () => {
    jest.useFakeTimers();
    try {
      mockGetToken.mockResolvedValue('tok');
      mockFetchProjects.mockResolvedValue([
        project('1', 'Run a 5K', '🏃', 'next'),
      ]);
      mockSetProjectStatus.mockImplementation(async (_t, id, status) => {
        const updated = project('1', 'Run a 5K', '🏃', status);
        mockFetchProjects.mockResolvedValue([]);
        return updated;
      });

      const { getByLabelText } = await renderScreen();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.press(getByLabelText('Run a 5K'));
      });
      await act(async () => {
        fireEvent.press(getByLabelText('Mark done'));
      });

      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });

      expect(mockSetProjectStatus).toHaveBeenCalledTimes(1);
      expect(mockSetProjectStatus.mock.calls[0][2]).toBe('done');
    } finally {
      jest.useRealTimers();
    }
  });
});
