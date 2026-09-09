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
import { defaultToastController } from '@zero/agent-core';

import type { Project, ProjectStatus, Task, WaitingCondition } from '@/lib/api';
import { resetProjectsApiForTest } from '@/lib/projects-collection';
import { resetTasksApiForTest } from '@/lib/tasks-collection';
import { resetWaitsApiForTest } from '@/lib/waits-collection';
import { __resetIconSuggestions } from '@/lib/icon-suggestions';

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

// The inline emoji keyboard (rn-emoji-keyboard's non-modal build) sits inside our
// combined picker sheet; substitute a passthrough exposing one tappable emoji so
// the manual-pick wiring is unit-testable (the real searchable grid is verified
// on-device).
function MockEmojiKeyboard({
  onEmojiSelected,
}: {
  onEmojiSelected?: (emoji: { emoji: string }) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Pick emoji 🎓"
      onPress={() => onEmojiSelected?.({ emoji: '🎓' })}
    >
      <RNText>🎓</RNText>
    </Pressable>
  );
}
jest.mock('rn-emoji-keyboard', () => ({
  __esModule: true,
  EmojiKeyboard: MockEmojiKeyboard,
}));

const mockFetchProjects = jest.fn<() => Promise<Project[]>>();
const mockSetProjectStatus =
  jest.fn<(getToken: unknown, id: string, status: ProjectStatus) => Promise<Project>>();
const mockDeleteProject =
  jest.fn<(getToken: unknown, id: string) => Promise<void>>();
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
const mockFetchIconSuggestions =
  jest.fn<
    (
      getToken: unknown,
      input: { title: string; description?: string | null },
    ) => Promise<string[]>
  >();
const mockCompleteTask =
  jest.fn<(getToken: unknown, id: string) => Promise<Task>>();
const mockReopenTask =
  jest.fn<(getToken: unknown, id: string) => Promise<Task>>();
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
  deleteProject: (getToken: unknown, id: string) =>
    mockDeleteProject(getToken, id),
  fetchIconSuggestions: (
    getToken: unknown,
    input: { title: string; description?: string | null },
  ) => mockFetchIconSuggestions(getToken, input),
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
  completeTask: (getToken: unknown, id: string) => mockCompleteTask(getToken, id),
  reopenTask: (getToken: unknown, id: string) => mockReopenTask(getToken, id),
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

const taskRow = (id: string, text: string): Task => ({
  id,
  text,
  showUpDate: '2023-01-01',
  createdAt: '2023-01-01T00:00:00.000Z',
  completedAt: null,
  projectId: '1',
  takenOnAt: null,
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
    mockDeleteProject.mockReset();
    mockDeleteProject.mockResolvedValue(undefined);
    mockSetProjectStatus.mockClear();
    mockEditProject.mockClear();
    mockAddTask.mockReset();
    mockCompleteTask.mockReset();
    mockReopenTask.mockReset();
    defaultToastController.dismiss();
    mockFetchTasks.mockReset();
    mockFetchTasks.mockResolvedValue([]);
    mockFetchWaits.mockReset();
    mockFetchWaits.mockResolvedValue([]);
    mockFetchProjects.mockReset();
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃', 'next')]);
    mockGetToken.mockResolvedValue('tok');
    __resetIconSuggestions();
    mockFetchIconSuggestions.mockReset();
    mockFetchIconSuggestions.mockResolvedValue(['🌟', '🚀']);
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

  it('completes a task and offers Undo in a toast that reopens it', async () => {
    mockFetchTasks.mockResolvedValue([taskRow('t1', 'buy running shoes')]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return { ...taskRow('t1', 'buy running shoes'), completedAt: '2023-01-02T00:00:00.000Z' };
    });
    mockReopenTask.mockResolvedValue(taskRow('t1', 'buy running shoes'));

    const { getByLabelText, queryByText } = await renderScreen();
    await waitFor(() =>
      expect(getByLabelText('Complete "buy running shoes"')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Complete "buy running shoes"'));
    });
    await waitFor(() => expect(mockCompleteTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByText('buy running shoes')).toBeNull());

    // A single Undo toast is offered; tapping it reopens the task on the server.
    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe('Completed');
    expect(snap[0].action?.label).toBe('Undo');
    await act(async () => {
      snap[0].action?.onPress();
    });
    await waitFor(() =>
      expect(mockReopenTask).toHaveBeenCalledWith(expect.anything(), 't1'),
    );
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

    const { getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Change icon')).toBeTruthy());

    // Tapping the icon opens the combined picker; the full grid is inline, right
    // below the suggestions.
    await act(async () => {
      fireEvent.press(getByLabelText('Change icon'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Pick emoji 🎓'));
    });

    expect(mockEditProject).toHaveBeenCalledTimes(1);
    expect(mockEditProject.mock.calls[0][2]).toEqual({ icon: '🎓' });
  });

  it('shows AI icon suggestions on top and applies a tapped one', async () => {
    mockEditProject.mockImplementation(async (_t, id, fields) => ({
      ...project('1', 'Run a 5K', (fields.icon as string) ?? '🏃', 'next'),
    }));

    const { getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Change icon')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Change icon'));
    });
    // The sheet's fetch-on-open fires because nothing warmed this project.
    await waitFor(() =>
      expect(mockFetchIconSuggestions).toHaveBeenCalledTimes(1),
    );
    const chip = await waitFor(() =>
      getByLabelText('Use suggested icon 🌟'),
    );
    await act(async () => {
      fireEvent.press(chip);
    });

    expect(mockEditProject).toHaveBeenCalledTimes(1);
    expect(mockEditProject.mock.calls[0][2]).toEqual({ icon: '🌟' });
  });

  it('refreshes suggestions on demand', async () => {
    const { getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Change icon')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Change icon'));
    });
    await waitFor(() =>
      expect(mockFetchIconSuggestions).toHaveBeenCalledTimes(1),
    );
    await act(async () => {
      fireEvent.press(getByLabelText('Refresh suggested icons'));
    });
    await waitFor(() =>
      expect(mockFetchIconSuggestions).toHaveBeenCalledTimes(2),
    );
  });

  it('keeps the full picker present when suggestions fail', async () => {
    mockFetchIconSuggestions.mockRejectedValue(new Error('network down'));

    const { getByLabelText, getByText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Change icon')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Change icon'));
    });
    await waitFor(() => expect(getByText("Couldn't load suggestions")).toBeTruthy());
    // The full manual grid sits inline in the same sheet, always available.
    expect(getByLabelText('Pick emoji 🎓')).toBeTruthy();
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

  it('marks done immediately and pops', async () => {
    mockSetProjectStatus.mockResolvedValue(project('1', 'ship', '📁', 'done'));
    const { getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project actions')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Project actions'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Mark done'));
    });

    await waitFor(() =>
      expect(mockSetProjectStatus).toHaveBeenCalledWith(
        expect.anything(),
        '1',
        'done',
      ),
    );
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('deletes immediately and pops', async () => {
    const { getByLabelText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project actions')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Project actions'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Delete project'));
    });

    await waitFor(() =>
      expect(mockDeleteProject).toHaveBeenCalledWith(expect.anything(), '1'),
    );
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
