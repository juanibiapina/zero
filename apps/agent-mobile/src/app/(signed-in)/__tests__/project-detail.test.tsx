import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  act,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from '@testing-library/react-native';
import { Pressable, Text as RNText, View } from 'react-native';

import type { Project, ProjectStatus, Task, WaitingCondition } from '@/lib/api';
import { resetProjectsApiForTest } from '@/lib/projects-collection';
import { resetTasksApiForTest } from '@/lib/tasks-collection';
import { resetWaitsApiForTest } from '@/lib/waits-collection';

import ProjectDetailScreen from '../projects/[id]';

// Trigger pull-to-refresh: the scroll host carries the RefreshControl element on
// its `refreshControl` prop, so invoke that control's onRefresh the way a real
// pull would.
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

// Route params + navigation. The default renders project '1'; a test can
// override the id before rendering.
let mockCurrentId = '1';
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockCurrentId }),
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
}));

// The two short sub-interaction sheets (icon picker, status/delete actions) are
// the only @expo/ui on the screen; the body is plain RN. Substitute RN
// passthroughs so the wiring is unit-testable (the real native controls are
// verified on-device). The mock BottomSheet renders children only when
// presented, like the real sheet; Button exposes its label as the a11y name.
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
  BottomSheet: MockBottomSheet,
}));

// The full emoji picker owns a native modal; substitute a passthrough that, when
// open, exposes one tappable emoji so the icon-pick wiring is unit-testable (the
// real searchable picker is verified on-device).
function MockEmojiPicker({
  open,
  onEmojiSelected,
}: {
  open?: boolean;
  onEmojiSelected?: (emoji: { emoji: string }) => void;
}) {
  return open ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Pick emoji 🎓"
      onPress={() => onEmojiSelected?.({ emoji: '🎓' })}
    >
      <RNText>🎓</RNText>
    </Pressable>
  ) : null;
}
jest.mock('rn-emoji-keyboard', () => ({
  __esModule: true,
  default: MockEmojiPicker,
}));

const mockFetchProjects = jest.fn<() => Promise<Project[]>>();
const mockSetProjectStatus =
  jest.fn<(getToken: unknown, id: string, status: ProjectStatus) => Promise<Project>>();
const mockEditProject =
  jest.fn<
    (getToken: unknown, id: string, fields: Record<string, unknown>) => Promise<Project>
  >();
const mockFetchTasks = jest.fn<() => Promise<Task[]>>();
const mockAddTask =
  jest.fn<
    (
      getToken: unknown,
      task: { id: string; text: string; showUpDate: string; projectId: string | null },
    ) => Promise<Task>
  >();
const mockFetchWaits = jest.fn<() => Promise<WaitingCondition[]>>();
const mockAddWaitingCondition =
  jest.fn<
    (condition: { id: string; projectId: string; kind: string; text: string | null }) => Promise<WaitingCondition>
  >();
jest.mock('@/lib/api', () => ({
  fetchProjects: () => mockFetchProjects(),
  addProject: () => Promise.reject(new Error('not used')),
  setProjectStatus: (getToken: unknown, id: string, status: ProjectStatus) =>
    mockSetProjectStatus(getToken, id, status),
  editProject: (getToken: unknown, id: string, fields: Record<string, unknown>) =>
    mockEditProject(getToken, id, fields),
  deleteProject: () => Promise.resolve(),
  fetchWaits: () => mockFetchWaits(),
  addWaitingCondition: (
    _getToken: unknown,
    condition: { id: string; projectId: string; kind: string; text: string | null },
  ) => mockAddWaitingCondition(condition),
  resolveWaitingCondition: () => Promise.reject(new Error('not used')),
  deleteWaitingCondition: () => Promise.resolve(),
  fetchTasks: () => mockFetchTasks(),
  addTask: (
    getToken: unknown,
    task: { id: string; text: string; showUpDate: string; projectId: string | null },
  ) => mockAddTask(getToken, task),
  completeTask: () => Promise.reject(new Error('not used')),
  setTaskTakenOn: () => Promise.reject(new Error('not used')),
}));

// Capture the Done/Delete handback to the list.
const mockRequestLeave = jest.fn<(id: string, kind: string) => void>();
jest.mock('@/lib/project-leave', () => ({
  requestProjectLeave: (id: string, kind: string) => mockRequestLeave(id, kind),
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
      <ProjectDetailScreen />
    </QueryClientProvider>,
  );
};

describe('ProjectDetailScreen', () => {
  beforeEach(() => {
    mockCurrentId = '1';
    resetProjectsApiForTest();
    resetTasksApiForTest();
    resetWaitsApiForTest();
    mockBack.mockReset();
    mockRequestLeave.mockReset();
    mockSetProjectStatus.mockClear();
    mockEditProject.mockClear();
    mockAddTask.mockReset();
    mockFetchTasks.mockReset();
    mockFetchTasks.mockResolvedValue([]);
    mockFetchWaits.mockReset();
    mockFetchWaits.mockResolvedValue([]);
    mockFetchProjects.mockReset();
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃', 'next')]);
    mockGetToken.mockResolvedValue('tok');
  });

  it('shows the project title as an editable heading', async () => {
    const { getByLabelText } = await renderScreen();
    await waitFor(() =>
      expect(getByLabelText('Project title').props.value).toBe('Run a 5K'),
    );
  });

  it('adds a task to the project from its screen', async () => {
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

    const { getByLabelText, getByPlaceholderText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project title')).toBeTruthy());

    // Adding is a plus FAB that expands into the quick-add bar.
    await act(async () => {
      fireEvent.press(getByLabelText('Add a task'));
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
    expect(mockAddTask.mock.calls[0][1].projectId).toBe('1');
  });

  it('adds a free-text waiting condition', async () => {
    mockAddWaitingCondition.mockImplementation(async (condition) => {
      const added: WaitingCondition = {
        ...condition,
        kind: condition.kind as WaitingCondition['kind'],
        refId: null,
        targetStatus: null,
        resolvedAt: null,
        createdAt: '2023-01-01T00:00:00.000Z',
      };
      mockFetchWaits.mockResolvedValue([added]);
      return added;
    });

    const { getByLabelText, getByPlaceholderText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project title')).toBeTruthy());

    const input = getByPlaceholderText('Waiting on… (e.g. the letter comes back)');
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
  });

  it('changes the icon from the emoji picker', async () => {
    mockEditProject.mockImplementation(async (_t, id, fields) => ({
      ...project('1', 'Run a 5K', (fields.icon as string) ?? '🏃', 'next'),
    }));

    const { getByLabelText, queryByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Change icon')).toBeTruthy());

    // The picker is behind the icon tap (de-emphasized).
    await act(async () => {
      fireEvent.press(getByLabelText('Change icon'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Pick emoji 🎓'));
    });

    expect(mockEditProject).toHaveBeenCalledTimes(1);
    expect(mockEditProject.mock.calls[0][2]).toEqual({ icon: '🎓' });
    // Picking closes the picker.
    expect(queryByLabelText('Pick emoji 🎓')).toBeNull();
  });

  it('moves the project to backlog from the actions sheet', async () => {
    mockSetProjectStatus.mockResolvedValue(project('1', 'Run a 5K', '🏃', 'backlog'));

    const { getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project actions')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Project actions'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Move to backlog'));
    });

    expect(mockSetProjectStatus).toHaveBeenCalledTimes(1);
    expect(mockSetProjectStatus.mock.calls[0][2]).toBe('backlog');
  });

  it('marks done by handing back to the list and popping', async () => {
    const { getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project actions')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Project actions'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Mark done'));
    });

    expect(mockRequestLeave).toHaveBeenCalledWith('1', 'done');
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('deletes by handing back to the list and popping', async () => {
    const { getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project actions')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Project actions'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Delete project'));
    });

    expect(mockRequestLeave).toHaveBeenCalledWith('1', 'delete');
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('re-pulls the project when the screen is pulled to refresh', async () => {
    const screen = await renderScreen();
    await waitFor(() =>
      expect(screen.getByLabelText('Project title').props.value).toBe('Run a 5K'),
    );

    const before = mockFetchProjects.mock.calls.length;
    await act(async () => {
      pullToRefresh(screen);
    });

    await waitFor(() =>
      expect(mockFetchProjects.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('offers a way back when the project id is unknown', async () => {
    mockCurrentId = 'nope';
    const { getByText, getByLabelText } = await renderScreen();
    await waitFor(() =>
      expect(getByText('This project is no longer here.')).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.press(getByLabelText('Back to projects'));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
