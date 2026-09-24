import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  act,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from '@testing-library/react-native';
import { Alert, BackHandler, Pressable, Text as RNText, View } from 'react-native';
import {
  defaultToastController,
  localToday,
  tomorrow,
  type AddProjectAttention,
} from '@zero/agent-core';

import type { Project, ProjectState, Task, WaitingCondition } from '@/lib/api';
import { resetProjectsApiForTest } from '@/lib/projects-collection';
import { resetTasksApiForTest } from '@/lib/tasks-collection';
import { resetWaitsApiForTest } from '@/lib/waits-collection';
import { __resetIconSuggestions } from '@/lib/icon-suggestions';

import ProjectDetailScreen from '../projects/[id]';

const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
const confirmDelete = () => mockAlert.mock.calls.at(-1)?.[2]?.find((b) => b.text === 'Delete')?.onPress?.();

// Trigger pull-to-refresh: the scroll host carries the RefreshControl element on
// its `refreshControl` prop, so invoke that control's onRefresh the way a real
// pull would.
const pullToRefresh = (screen: RenderResult) => {
  const [scroll] = screen.container.queryAll(
    (n) => n.props?.refreshControl != null,
  );
  scroll.props.refreshControl.props.onRefresh();
};

// A native touch reaches the workspace observer before the pressed control. RTL
// does not bubble synthetic presses through host views, so screen-action tests
// emit both observable events in their native order.
const pressWorkspaceAction = async (
  screen: RenderResult,
  target: Parameters<typeof fireEvent.press>[0],
) => {
  await act(async () => {
    fireEvent(screen.getByTestId('project-workspace'), 'touchStart');
    fireEvent.press(target);
  });
};

const mockGetToken = jest.fn<() => Promise<string | null>>();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

// Route params + navigation. The default renders project '1'; a test can
// override the id before rendering.
let mockCurrentId = '1';
let mockFocusCleanup: (() => void) | null = null;
const mockBack = jest.fn();
const mockNavigate = jest.fn<(href: string, options?: unknown) => void>();
const mockPush = jest.fn<(href: string) => void>();
function mockUseFocusEffect(effect: () => void | (() => void)) {
  // This adapter intentionally implements Expo Router's hook interface.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const cleanup = effect();
    mockFocusCleanup = typeof cleanup === 'function' ? cleanup : null;
    return () => {
      if (typeof cleanup === 'function') cleanup();
      if (mockFocusCleanup === cleanup) mockFocusCleanup = null;
    };
  }, [effect]);
}
jest.mock('expo-router', () => ({
  router: {
    navigate: (href: string, options?: unknown) => mockNavigate(href, options),
  },
  useFocusEffect: mockUseFocusEffect,
  useLocalSearchParams: () => ({ id: mockCurrentId }),
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

let mockHardwareBack: (() => boolean | null | undefined) | null = null;
jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
  const trigger = () => handler({} as never);
  mockHardwareBack = trigger;
  return {
    remove: () => {
      if (mockHardwareBack === trigger) mockHardwareBack = null;
    },
  };
});

// Status uses @expo/ui rows in a native sheet and settings uses a native menu;
// the screen body is plain RN. Substitute RN adapters so their wiring is
// unit-testable (the real native controls are verified on-device). The mock
// BottomSheet renders children only when presented, like the real sheet.
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
function MockIcon() {
  return <View />;
}
MockIcon.select = () => 'mock-icon';
function MockListItem({
  children,
  onPress,
}: {
  children?: ReactNode;
  onPress?: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {children}
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
  return (
    <View>
      <Pressable onPress={() => setOpen(true)}>{children}</Pressable>
      {open
        ? actions.map((action) => (
            <Pressable
              key={action.id ?? action.title}
              accessibilityRole="button"
              onPress={() => {
                setOpen(false);
                onPressAction?.({
                  nativeEvent: { event: action.id ?? action.title },
                });
              }}
            >
              <RNText>{action.title}</RNText>
            </Pressable>
          ))
        : null}
    </View>
  );
}
jest.mock('@expo/ui/community/menu', () => ({
  __esModule: true,
  MenuView: MockMenuView,
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
const mockAddProject =
  jest.fn<
    (
      getToken: unknown,
      project: { id: string; title: string; sourceCaptureId: string | null },
    ) => Promise<Project>
  >();
const mockSetProjectState =
  jest.fn<(getToken: unknown, id: string, state: ProjectState) => Promise<Project>>();
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
const mockEditTask =
  jest.fn<(getToken: unknown, id: string, text: string) => Promise<Task>>();
const mockRescheduleTask =
  jest.fn<
    (getToken: unknown, id: string, showUpDate: string | null) => Promise<Task>
  >();
const mockReorderTask =
  jest.fn<(getToken: unknown, id: string, sortKey: string) => Promise<Task>>();
const mockSetTaskProject =
  jest.fn<
    (getToken: unknown, id: string, projectId: string | null) => Promise<Task>
  >();
const mockFetchWaits = jest.fn<() => Promise<WaitingCondition[]>>();
const mockDeleteWaitingCondition = jest.fn<(id: string) => Promise<void>>();
const mockAddWaitingCondition =
  jest.fn<
    (condition: AddProjectAttention & { id: string }) => Promise<WaitingCondition>
  >();
jest.mock('@/lib/api', () => ({
  fetchProjects: () => mockFetchProjects(),
  addProject: (
    getToken: unknown,
    project: { id: string; title: string; sourceCaptureId: string | null },
  ) => mockAddProject(getToken, project),
  setProjectState: (getToken: unknown, id: string, state: ProjectState) =>
    mockSetProjectState(getToken, id, state),
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
    condition: AddProjectAttention & { id: string },
  ) => mockAddWaitingCondition(condition),
  resolveWaitingCondition: () => Promise.reject(new Error('not used')),
  deleteWaitingCondition: (_getToken: unknown, id: string) =>
    mockDeleteWaitingCondition(id),
  fetchTasks: () => mockFetchTasks(),
  addTask: (
    getToken: unknown,
    task: { id: string; text: string; showUpDate: string; projectId: string | null },
  ) => mockAddTask(getToken, task),
  completeTask: (getToken: unknown, id: string) => mockCompleteTask(getToken, id),
  reopenTask: (getToken: unknown, id: string) => mockReopenTask(getToken, id),
  editTask: (getToken: unknown, id: string, text: string) =>
    mockEditTask(getToken, id, text),
  rescheduleTask: (getToken: unknown, id: string, showUpDate: string | null) =>
    mockRescheduleTask(getToken, id, showUpDate),
  reorderTask: (getToken: unknown, id: string, sortKey: string) =>
    mockReorderTask(getToken, id, sortKey),
  setTaskProject: (getToken: unknown, id: string, projectId: string | null) =>
    mockSetTaskProject(getToken, id, projectId),
}));

const project = (
  id: string,
  title: string,
  icon = '📁',
  state: ProjectState | 'next' = 'in-play',
  description: string | null = null,
): Project => ({
  id,
  title,
  icon,
  description,
  state: state === 'next' ? 'in-play' : state,
  createdAt: '2023-01-01T00:00:00.000Z',
});

const dependencyRow = (
  id: string,
  projectId: string,
  refId: string,
): WaitingCondition => ({
  id,
  projectId,
  kind: 'project-status',
  text: null,
  refId,
  targetStatus: 'done',
  resolvedAt: null,
  createdAt: '2023-01-01T00:00:00.000Z',
});

const taskRow = (id: string, text: string, over: Partial<Task> = {}): Task => ({
  id,
  text,
  showUpDate: over.showUpDate === undefined ? '2023-01-01' : over.showUpDate,
  createdAt: over.createdAt ?? '2023-01-01T00:00:00.000Z',
  completedAt: over.completedAt ?? null,
  projectId: over.projectId === undefined ? '1' : over.projectId,
  sortKey: over.sortKey === undefined ? null : over.sortKey,
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
    mockFocusCleanup = null;
    mockHardwareBack = null;
    (global as { __reorderableOnReorder?: unknown }).__reorderableOnReorder =
      undefined;
    (global as { __lastPanGesture?: unknown }).__lastPanGesture = undefined;
    resetProjectsApiForTest();
    resetTasksApiForTest();
    resetWaitsApiForTest();
    mockAlert.mockClear();
    mockBack.mockReset();
    mockNavigate.mockReset();
    mockPush.mockReset();
    mockAddProject.mockReset();
    mockDeleteProject.mockReset();
    mockDeleteProject.mockResolvedValue(undefined);
    mockSetProjectState.mockClear();
    mockEditProject.mockReset();
    mockEditProject.mockImplementation(async (_token, id, fields) => ({
      ...project(id, 'Run a 5K', '🏃'),
      ...fields,
    }));
    mockAddTask.mockReset();
    mockAddWaitingCondition.mockReset();
    mockDeleteWaitingCondition.mockReset();
    mockDeleteWaitingCondition.mockResolvedValue(undefined);
    mockCompleteTask.mockReset();
    mockReopenTask.mockReset();
    mockEditTask.mockReset();
    mockRescheduleTask.mockReset();
    mockReorderTask.mockReset();
    mockSetTaskProject.mockReset();
    defaultToastController.dismiss();
    mockFetchTasks.mockReset();
    mockFetchTasks.mockResolvedValue([]);
    mockFetchWaits.mockReset();
    mockFetchWaits.mockResolvedValue([]);
    mockFetchProjects.mockReset();
    mockFetchProjects.mockResolvedValue([project('1', 'Run a 5K', '🏃')]);
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

  it('saves a changed description on blur', async () => {
    const screen = await renderScreen();
    const input = await waitFor(() =>
      screen.getByLabelText('Project description'),
    );

    await fireEvent.changeText(input, 'Finish a community race');
    await fireEvent(input, 'blur');

    await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(1));
    expect(mockEditProject.mock.calls[0][2]).toEqual({
      description: 'Finish a community race',
    });
  });

  it('saves the description before Add opens and keeps it while adding a Task', async () => {
    mockAddTask.mockImplementation(async (_token, input) => ({
      ...taskRow(input.id, input.text),
      projectId: input.projectId,
      showUpDate: input.showUpDate,
    }));
    const screen = await renderScreen();
    const description = await waitFor(() =>
      screen.getByLabelText('Project description'),
    );
    await fireEvent.changeText(description, 'Build enough endurance to finish');

    await pressWorkspaceAction(screen, screen.getByLabelText('Add'));

    expect(screen.getByPlaceholderText('Add a task')).toBeTruthy();
    await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(1));
    expect(mockEditProject.mock.calls[0][2]).toEqual({
      description: 'Build enough endurance to finish',
    });

    const task = screen.getByPlaceholderText('Add a task');
    await fireEvent.changeText(task, 'Run five kilometers');
    await fireEvent(task, 'submitEditing');

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Project description').props.value).toBe(
      'Build enough endurance to finish',
    );
    expect(mockEditProject).toHaveBeenCalledTimes(1);
  });

  it('saves the description before the visible Back action', async () => {
    const screen = await renderScreen();
    const input = await waitFor(() =>
      screen.getByLabelText('Project description'),
    );
    await fireEvent.changeText(input, 'Cross the finish line');

    await fireEvent.press(screen.getByLabelText('Back to projects'));

    await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(1));
    expect(mockEditProject.mock.calls[0][2]).toEqual({
      description: 'Cross the finish line',
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockEditProject.mock.invocationCallOrder[0]).toBeLessThan(
      mockBack.mock.invocationCallOrder[0],
    );
  });

  it('saves the description on unhandled Android Back and leaves the pop to the navigator', async () => {
    const screen = await renderScreen();
    const input = await waitFor(() =>
      screen.getByLabelText('Project description'),
    );
    await fireEvent.changeText(input, 'Cross the finish line');

    let handled: boolean | null | undefined = true;
    await act(async () => {
      handled = mockHardwareBack?.();
    });

    expect(handled).toBe(false);
    await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(1));
    expect(mockEditProject.mock.calls[0][2]).toEqual({
      description: 'Cross the finish line',
    });
  });

  it.each([
    { name: 'identity status', kind: 'status' as const },
    { name: 'After relationship', kind: 'relationship' as const },
    { name: 'Task detail', kind: 'task' as const },
  ])('saves the description before the $name action', async ({ kind }) => {
    if (kind === 'relationship') {
      mockFetchProjects.mockResolvedValue([
        project('1', 'Run a 5K', '🏃'),
        project('2', 'Buy shoes', '👟'),
      ]);
      mockFetchWaits.mockResolvedValue([dependencyRow('a1', '1', '2')]);
    }
    if (kind === 'task') {
      mockFetchTasks.mockResolvedValue([taskRow('t1', 'Train')]);
    }
    const screen = await renderScreen();
    const input = await waitFor(() =>
      screen.getByLabelText('Project description'),
    );
    await fireEvent.changeText(input, 'Be ready for race day');

    const target =
      kind === 'status'
        ? screen.getByLabelText('Project status: Next')
        : kind === 'relationship'
          ? screen.getByLabelText('Open project Buy shoes')
          : screen.getByLabelText('Edit "Train", scheduled Today');
    await pressWorkspaceAction(screen, target);

    await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(1));
    expect(mockEditProject.mock.calls[0][2]).toEqual({
      description: 'Be ready for race day',
    });
    if (kind === 'status') expect(screen.getByText('Project status')).toBeTruthy();
    if (kind === 'relationship') {
      expect(mockPush).toHaveBeenCalledWith('/projects/2');
    }
    if (kind === 'task') expect(screen.getByLabelText('Set project')).toBeTruthy();
  });

  it.each(['focus loss', 'unmount'] as const)(
    'saves a dirty description on %s',
    async (exit) => {
      const screen = await renderScreen();
      const input = await waitFor(() =>
        screen.getByLabelText('Project description'),
      );
      await fireEvent.changeText(input, 'Keep moving forward');

      await act(async () => {
        if (exit === 'focus loss') mockFocusCleanup?.();
        else screen.unmount();
      });

      await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(1));
      expect(mockEditProject.mock.calls[0][2]).toEqual({
        description: 'Keep moving forward',
      });
    },
  );

  it('queues one edit when touch, blur, Back, and focus cleanup overlap', async () => {
    const screen = await renderScreen();
    const input = await waitFor(() =>
      screen.getByLabelText('Project description'),
    );
    await fireEvent.changeText(input, 'One durable description');

    await act(async () => {
      fireEvent(screen.getByTestId('project-workspace'), 'touchStart');
      fireEvent(input, 'blur');
      mockHardwareBack?.();
      mockFocusCleanup?.();
    });

    await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(1));
    expect(mockEditProject.mock.calls[0][2]).toEqual({
      description: 'One durable description',
    });
  });

  it('does not edit an unchanged description', async () => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Run a 5K', '🏃', 'in-play', 'Finish the race'),
    ]);
    const screen = await renderScreen();
    const input = await waitFor(() =>
      screen.getByLabelText('Project description'),
    );

    await fireEvent(input, 'blur');
    await pressWorkspaceAction(screen, screen.getByLabelText('Add'));

    expect(mockEditProject).not.toHaveBeenCalled();
  });

  it('clears a stored description to null', async () => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Run a 5K', '🏃', 'in-play', 'Finish the race'),
    ]);
    const screen = await renderScreen();
    const input = await waitFor(() =>
      screen.getByLabelText('Project description'),
    );

    await fireEvent.changeText(input, '   ');
    await fireEvent(input, 'blur');

    await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(1));
    expect(mockEditProject.mock.calls[0][2]).toEqual({ description: null });
  });

  it('keeps a failed description draft and retries it on a later flush', async () => {
    mockEditProject
      .mockRejectedValueOnce(new Error('offline write failed'))
      .mockImplementationOnce(async (_token, id, fields) => ({
        ...project(id, 'Run a 5K', '🏃'),
        ...fields,
      }));
    const screen = await renderScreen();
    const input = await waitFor(() =>
      screen.getByLabelText('Project description'),
    );
    await fireEvent.changeText(input, 'A draft worth keeping');

    await fireEvent(input, 'blur');
    await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText('offline write failed')).toBeTruthy(),
    );
    expect(screen.getByLabelText('Project description').props.value).toBe(
      'A draft worth keeping',
    );

    await fireEvent(input, 'blur');

    await waitFor(() => expect(mockEditProject).toHaveBeenCalledTimes(2));
    expect(mockEditProject.mock.calls[1][2]).toEqual({
      description: 'A draft worth keeping',
    });
  });

  it('hides the Tasks heading when the project has no open tasks', async () => {
    // Default fixture resolves empty tasks + empty waits.
    const { getByLabelText, queryByText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project title')).toBeTruthy());
    expect(queryByText('Tasks')).toBeNull();
  });

  it('hides the Waiting on heading when the project has no conditions', async () => {
    const { getByLabelText, queryByText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project title')).toBeTruthy());
    expect(queryByText('Waiting on')).toBeNull();
  });

  it('explains a task-derived wait in the status and on its source task', async () => {
    const nextDay = tomorrow(localToday());
    mockFetchTasks.mockResolvedValue([
      {
        ...taskRow('t1', 'book flights'),
        showUpDate: nextDay,
      },
    ]);

    const { getByText, queryByText } = await renderScreen();

    await waitFor(() =>
      expect(getByText('Waiting · until Tomorrow')).toBeTruthy(),
    );
    expect(getByText('Scheduled · Tomorrow')).toBeTruthy();
    expect(queryByText('Waiting on')).toBeNull();
    expect(queryByText('auto')).toBeNull();
  });

  it('keeps a real waiting condition primary while showing the task schedule', async () => {
    const nextDay = tomorrow(localToday());
    mockFetchTasks.mockResolvedValue([
      {
        ...taskRow('t1', 'book flights'),
        showUpDate: nextDay,
      },
    ]);
    mockFetchWaits.mockResolvedValue([
      {
        id: 'w1',
        projectId: '1',
        kind: 'free-text',
        text: 'the letter comes back',
        refId: null,
        targetStatus: null,
        resolvedAt: null,
        createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      },
    ]);

    const { getByText, queryByText } = await renderScreen();

    await waitFor(() => expect(getByText(/^Waiting · for /)).toBeTruthy());
    expect(queryByText('Waiting · until Tomorrow')).toBeNull();
    expect(getByText('Scheduled · Tomorrow')).toBeTruthy();
    expect(getByText('Waiting on')).toBeTruthy();
    expect(getByText('the letter comes back')).toBeTruthy();
    expect(queryByText(/^until Tomorrow$/)).toBeNull();
  });

  it('shows an After relationship separately and opens its target Project', async () => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Move house'),
      project('2', 'Sell old house', '🏠'),
    ]);
    mockFetchWaits.mockResolvedValue([dependencyRow('dependency', '1', '2')]);

    const screen = await renderScreen();

    await waitFor(() =>
      expect(screen.getByText('After · 🏠 Sell old house')).toBeTruthy(),
    );
    expect(screen.getByText('After')).toBeTruthy();
    expect(screen.queryByText('Must be completed first')).toBeNull();
    expect(screen.queryByText('auto')).toBeNull();

    await fireEvent.press(
      screen.getByLabelText('Open project Sell old house'),
    );
    expect(mockPush).toHaveBeenCalledWith('/projects/2');
  });

  it('removes only the selected After relationship and recalculates the Project', async () => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Move house'),
      project('2', 'Sell old house'),
    ]);
    mockFetchWaits.mockResolvedValue([dependencyRow('dependency', '1', '2')]);
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('After')).toBeTruthy());

    await fireEvent.press(
      screen.getByLabelText('Remove After relationship with Sell old house'),
    );

    await waitFor(() =>
      expect(mockDeleteWaitingCondition).toHaveBeenCalledWith('dependency'),
    );
    expect(screen.queryByText('After')).toBeNull();
    expect(screen.getByText('Next')).toBeTruthy();
  });

  it('adds an eligible After Project from the main Add surface', async () => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Move house'),
      project('2', 'Sell old house', '🏠'),
    ]);
    mockAddWaitingCondition.mockImplementation(async (condition) => ({
      ...condition,
      resolvedAt: null,
      createdAt: '2023-01-01T00:00:00.000Z',
    }));

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('Next')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Add'));
    expect(screen.getByPlaceholderText('Add a task')).toBeTruthy();
    expect(screen.queryByText('Add to Move house')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Add an After project'));

    await waitFor(() => expect(screen.getByLabelText('Filter projects')).toBeTruthy());
    expect(screen.queryByLabelText('No project')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Sell old house'));

    await waitFor(() =>
      expect(mockAddWaitingCondition).toHaveBeenCalledTimes(1),
    );
    expect(mockAddWaitingCondition.mock.calls[0][0]).toMatchObject({
      projectId: '1',
      kind: 'project-status',
      text: null,
      refId: '2',
      targetStatus: 'done',
    });
    expect(screen.getByLabelText('Project title').props.value).toBe('Move house');
  });

  it('shows the Tasks heading once the project has an open task', async () => {
    mockFetchTasks.mockResolvedValue([taskRow('t1', 'buy running shoes')]);
    const { getByText } = await renderScreen();
    await waitFor(() => expect(getByText('Tasks')).toBeTruthy());
  });

  it('shows project tasks in their manual order', async () => {
    mockFetchTasks.mockResolvedValue([
      taskRow('b', 'Banana', {
        sortKey: 'a1',
        createdAt: '2023-01-01T00:00:00.000Z',
      }),
      taskRow('a', 'Apple', {
        sortKey: 'a0',
        createdAt: '2023-01-02T00:00:00.000Z',
      }),
    ]);

    const { getAllByLabelText } = await renderScreen();
    await waitFor(() =>
      expect(getAllByLabelText(/^Edit "/)).toHaveLength(2),
    );

    expect(
      getAllByLabelText(/^Edit "/).map((row) => row.props.accessibilityLabel),
    ).toEqual([
      'Edit "Apple", scheduled Today',
      'Edit "Banana", scheduled Today',
    ]);
  });

  it('reorders a project task with a new key at its drop position', async () => {
    mockFetchTasks.mockResolvedValue([
      taskRow('a', 'Apple', { sortKey: 'a0' }),
      taskRow('other', 'Other project task', {
        projectId: '2',
        sortKey: 'a1',
      }),
      taskRow('b', 'Banana', { sortKey: 'a2' }),
      taskRow('c', 'Cherry', { sortKey: 'a3' }),
    ]);
    mockReorderTask.mockImplementation(async (_token, id, sortKey) =>
      taskRow(id, id, { sortKey }),
    );

    const { queryByText } = await renderScreen();
    await waitFor(() =>
      expect(
        typeof (global as { __reorderableOnReorder?: unknown })
          .__reorderableOnReorder,
      ).toBe('function'),
    );
    expect(queryByText('Other project task')).toBeNull();

    await act(async () => {
      (
        global as unknown as {
          __reorderableOnReorder: (event: { from: number; to: number }) => void;
        }
      ).__reorderableOnReorder({ from: 2, to: 0 });
    });

    await waitFor(() => expect(mockReorderTask).toHaveBeenCalledTimes(1));
    expect(mockReorderTask.mock.calls[0][1]).toBe('c');
    expect(mockReorderTask.mock.calls[0][2] < 'a0').toBe(true);
  });

  it('schedules an undated project task for today only after the swipe commits', async () => {
    mockFetchTasks.mockResolvedValue([
      taskRow('t1', 'Book flights', { showUpDate: null, sortKey: 'a0' }),
    ]);
    mockRescheduleTask.mockImplementation(async (_token, id, showUpDate) =>
      taskRow(id, 'Book flights', { showUpDate, sortKey: 'a0' }),
    );

    const { getByText } = await renderScreen();
    await waitFor(() => expect(getByText('Book flights')).toBeTruthy());
    expect(getByText('Next')).toBeTruthy();
    expect(getByText('Today')).toBeTruthy();

    const pan = (global as unknown as {
      __lastPanGesture: {
        __onStart: () => void;
        __onUpdate: (event: { translationX: number }) => void;
        __onEnd: (event: { velocityX: number }) => void;
      };
    }).__lastPanGesture;

    await act(async () => {
      pan.__onStart();
      pan.__onUpdate({ translationX: 80 });
      pan.__onEnd({ velocityX: 0 });
    });
    expect(mockRescheduleTask).not.toHaveBeenCalled();

    await act(async () => {
      pan.__onStart();
      pan.__onUpdate({ translationX: 160 });
      pan.__onEnd({ velocityX: 0 });
    });

    await waitFor(() => expect(mockRescheduleTask).toHaveBeenCalledTimes(1));
    expect(mockRescheduleTask.mock.calls[0][1]).toBe('t1');
    expect(mockRescheduleTask.mock.calls[0][2]).toBe(localToday());
    await waitFor(() => expect(getByText('Scheduled · Today')).toBeTruthy());
    await waitFor(() => expect(getByText('Active')).toBeTruthy());
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
        sortKey: null,
      };
      mockFetchTasks.mockResolvedValue([added]);
      return added;
    });

    const {
      getByLabelText,
      getByPlaceholderText,
      getByText,
      queryByLabelText,
    } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project title')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Add'));
    });
    expect(getByText('Task')).toBeTruthy();
    expect(getByText('Waiting')).toBeTruthy();
    expect(getByText('After')).toBeTruthy();
    expect(getByText('Project')).toBeTruthy();
    expect(getByLabelText('Add a task').props.accessibilityState.selected).toBe(true);
    expect(queryByLabelText('Add a capture')).toBeNull();
    expect(getByLabelText('Project title')).toBeTruthy();

    const input = getByPlaceholderText('Add a task');
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

  it('creates an independent Project from the Project Add action', async () => {
    mockAddProject.mockImplementation(async (_token, input) =>
      project(input.id, input.title),
    );

    const {
      getByLabelText,
      getByPlaceholderText,
      queryByPlaceholderText,
      queryByText,
    } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project title')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Add'));
    });

    expect(queryByText('Add to Run a 5K')).toBeNull();
    await act(async () => {
      fireEvent.press(getByLabelText('Add a project'));
    });
    const input = getByPlaceholderText('Name an outcome');
    await act(async () => {
      fireEvent.changeText(input, 'Run a half marathon');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(mockAddProject).toHaveBeenCalledTimes(1));
    const created = mockAddProject.mock.calls[0][1];
    expect(created.title).toBe('Run a half marathon');
    expect(created.sourceCaptureId).toBeNull();
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockAddWaitingCondition).not.toHaveBeenCalled();
    expect(queryByPlaceholderText('Name an outcome')).toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();

    const toast = defaultToastController.getSnapshot()[0];
    expect(toast).toBeDefined();
    if (!toast) throw new Error('Project-created toast is missing');
    expect(toast.message).toBe('Project created');
    expect(toast.description).toBe('📁 Run a half marathon');
    expect(toast.action?.label).toBe('View');

    await act(async () => {
      fireEvent.press(getByLabelText('Add'));
    });
    expect(queryByText('Add to Run a 5K')).toBeNull();
    expect(getByPlaceholderText('Add a task')).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });

    toast.action?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith(`/projects/${created.id}`, {
      withAnchor: true,
    });
  });

  it('opens the shared task editor when a task row is tapped and edits on dismiss', async () => {
    mockFetchTasks.mockResolvedValue([taskRow('t1', 'buy running shoes')]);
    mockEditTask.mockImplementation(async (_g, id, text) => {
      const edited = { ...taskRow(id, text) };
      mockFetchTasks.mockResolvedValue([edited]);
      return edited;
    });

    const { getByLabelText, getByDisplayValue, getByText, queryByLabelText } =
      await renderScreen();
    await waitFor(() =>
      expect(getByLabelText('Complete "buy running shoes"')).toBeTruthy(),
    );

    // Tapping the task text opens the same editor Home/Upcoming open.
    await act(async () => {
      fireEvent.press(
        getByLabelText('Edit "buy running shoes", scheduled Today'),
      );
    });
    expect(queryByLabelText('Open project Run a 5K')).toBeNull();
    expect(getByLabelText('Set project')).toBeTruthy();
    const input = getByDisplayValue('buy running shoes');
    await act(async () => {
      fireEvent.changeText(input, 'buy trail shoes');
    });
    // Dismissal (submit) commits the edit.
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('buy trail shoes')).toBeTruthy());
    expect(mockEditTask).toHaveBeenCalledTimes(1);
    expect(mockEditTask.mock.calls[0][1]).toBe('t1');
    expect(mockEditTask.mock.calls[0][2]).toBe('buy trail shoes');
  });

  it('adds a task with the date row and project row preset to this project, on a chosen date', async () => {
    mockAddTask.mockImplementation(async (_t, task) => {
      const added: Task = {
        id: task.id,
        text: task.text,
        showUpDate: task.showUpDate,
        createdAt: '2023-01-01T00:00:00.000Z',
        completedAt: null,
        projectId: task.projectId,
        sortKey: null,
      };
      mockFetchTasks.mockResolvedValue([added]);
      return added;
    });

    const { getByLabelText, getByPlaceholderText, getByText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project title')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Add'));
    });
    await act(async () => {
      fireEvent.press(getByText('Task'));
    });

    // The same composer Home uses: create-time date and project rows, with the
    // project preset to this screen (label = the project title, 'Run a 5K').
    expect(getByLabelText('No date')).toBeTruthy();
    expect(getByLabelText('Run a 5K')).toBeTruthy();

    // Pick Today from the scheduler the date row opens.
    await act(async () => {
      fireEvent.press(getByLabelText('No date'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Today'));
    });

    const input = getByPlaceholderText('Add a task');
    await act(async () => {
      fireEvent.changeText(input, 'buy running shoes');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledTimes(1));
    // Kept the preset project, dated to the chosen day.
    expect(mockAddTask.mock.calls[0][1].projectId).toBe('1');
    expect(mockAddTask.mock.calls[0][1].showUpDate).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it.each([false, true])('files a new task to another project (scheduled: %s)', async (scheduled) => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Run a 5K', '🏃'),
      project('2', 'Learn piano', '🎹'),
    ]);
    mockAddTask.mockImplementation(async (_t, task) => {
      const added: Task = {
        id: task.id,
        text: task.text,
        showUpDate: task.showUpDate,
        createdAt: '2023-01-01T00:00:00.000Z',
        completedAt: null,
        projectId: task.projectId,
        sortKey: null,
      };
      return added;
    });

    const { getByLabelText, getByPlaceholderText, getByText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project title')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Add'));
    });
    await act(async () => {
      fireEvent.press(getByText('Task'));
    });
    // The row is preset to this project; open the picker and switch to another.
    await act(async () => {
      fireEvent.press(getByLabelText('Run a 5K'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Learn piano'));
    });
    if (scheduled) {
      await act(async () => fireEvent.press(getByLabelText('No date')));
      await act(async () => fireEvent.press(getByLabelText('Tomorrow')));
    }

    const input = getByPlaceholderText('Add a task');
    await act(async () => {
      fireEvent.changeText(input, 'buy a metronome');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledTimes(1));
    // Filed to the picked project, not this screen's own.
    expect(mockAddTask.mock.calls[0][1].projectId).toBe('2');
    expect(mockAddTask.mock.calls[0][1].showUpDate).toBe(
      scheduled ? tomorrow(localToday()) : null,
    );
    const [toast] = defaultToastController.getSnapshot();
    expect(toast.message).toBe('Filed to project');
    toast.action?.onPress();
    if (scheduled) {
      expect(mockNavigate).toHaveBeenCalledWith('/browse/upcoming', { withAnchor: true });
    } else {
      expect(mockNavigate).toHaveBeenCalledWith('/projects/2', { withAnchor: true });
    }
  });

  it('completes a Project Task with Undo and Waiting actions', async () => {
    mockFetchTasks.mockResolvedValue([taskRow('t1', 'buy running shoes')]);
    mockCompleteTask.mockImplementation(async () => {
      mockFetchTasks.mockResolvedValue([]);
      return { ...taskRow('t1', 'buy running shoes'), completedAt: '2023-01-02T00:00:00.000Z' };
    });
    mockReopenTask.mockResolvedValue(taskRow('t1', 'buy running shoes'));

    const { getByLabelText, getByPlaceholderText, getByText, queryByText } =
      await renderScreen();
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
    expect(snap[0].description).toBe('🏃 Run a 5K');
    expect(snap[0].secondaryAction?.label).toBe('Waiting…');
    expect(snap[0].action?.label).toBe('Undo');
    await act(async () => snap[0].secondaryAction?.onPress());
    expect(getByPlaceholderText('What needs to happen?')).toBeTruthy();
    expect(getByText('Waiting on')).toBeTruthy();
    expect(getByLabelText('Project Run a 5K')).toBeTruthy();
    expect(getByLabelText('Waiting on')).toBeTruthy();
    expect(
      getByLabelText('Add waiting condition to Run a 5K'),
    ).toBeTruthy();
    expect(queryByText('What are you waiting for?')).toBeNull();
    await fireEvent.press(getByLabelText('Dismiss quick add'));
    await act(async () => {
      snap[0].action?.onPress();
    });
    await waitFor(() =>
      expect(mockReopenTask).toHaveBeenCalledWith(expect.anything(), 't1'),
    );
  });

  it('adds a free-text waiting condition', async () => {
    mockAddWaitingCondition.mockImplementation(async (condition) => {
      if (condition.kind !== 'free-text') throw new Error('expected manual Waiting');
      const added: WaitingCondition = {
        ...condition,
        resolvedAt: null,
        createdAt: '2023-01-01T00:00:00.000Z',
      };
      mockFetchWaits.mockResolvedValue([added]);
      return added;
    });

    const { getByLabelText, getByPlaceholderText, getByText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project title')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Add'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Add a waiting condition'));
    });
    expect(getByText('Waiting on')).toBeTruthy();
    expect(getByLabelText('Project Run a 5K')).toBeTruthy();
    expect(getByLabelText('Waiting on')).toBeTruthy();
    expect(
      getByLabelText('Add waiting condition to Run a 5K'),
    ).toBeTruthy();
    const input = getByPlaceholderText('What needs to happen?');
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
    expect(mockAddWaitingCondition.mock.calls[0][0].kind).toBe('free-text');
  });

  it('opens each populated section action in the same matching drawer mode', async () => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Run a 5K', '🏃'),
      project('2', 'Buy shoes', '👟'),
    ]);
    mockFetchTasks.mockResolvedValue([taskRow('t1', 'train')]);
    mockFetchWaits.mockResolvedValue([
      {
        id: 'w1',
        projectId: '1',
        kind: 'free-text',
        text: 'coach replies',
        refId: null,
        targetStatus: null,
        resolvedAt: null,
        createdAt: '2023-01-01T00:00:00.000Z',
      },
      dependencyRow('a1', '1', '2'),
    ]);

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('Tasks')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Add task'));
    expect(screen.getByLabelText('Add a task').props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByLabelText('Dismiss quick add'));

    await fireEvent.press(screen.getByLabelText('Add waiting condition'));
    expect(
      screen.getByLabelText('Add a waiting condition').props.accessibilityState
        .selected,
    ).toBe(true);
    expect(screen.getByPlaceholderText('What needs to happen?')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Dismiss quick add'));

    await fireEvent.press(screen.getByLabelText('Add After project'));
    expect(screen.getByLabelText('Filter projects')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Close project picker'));
    expect(
      screen.getByLabelText('Add an After project').props.accessibilityState
        .selected,
    ).toBe(true);
  });

  it('preserves per-mode drafts through After cancellation and resets after discard', async () => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Run a 5K', '🏃'),
      project('2', 'Buy shoes', '👟'),
    ]);
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByLabelText('Add')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Add'));
    await fireEvent.changeText(
      screen.getByPlaceholderText('Add a task'),
      'task draft',
    );
    await fireEvent.press(screen.getByLabelText('Add a waiting condition'));
    await fireEvent.changeText(
      screen.getByPlaceholderText('What needs to happen?'),
      'waiting draft',
    );
    await fireEvent.press(screen.getByLabelText('Add an After project'));
    await fireEvent.press(screen.getByLabelText('Close project picker'));

    await fireEvent.press(screen.getByLabelText('Add a task'));
    expect(screen.getByDisplayValue('task draft')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Add a waiting condition'));
    expect(screen.getByDisplayValue('waiting draft')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Dismiss quick add'));
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Discard'));
    await fireEvent.press(screen.getByLabelText('Add'));
    expect(screen.getByPlaceholderText('Add a task').props.value).toBe('');
    expect(screen.getByLabelText('Add a task').props.accessibilityState.selected).toBe(true);
    expect(screen.queryByText('Add waiting condition')).toBeNull();
    expect(screen.queryByPlaceholderText('What are you waiting for?')).toBeNull();
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

  it('moves the project to backlog from its status', async () => {
    mockSetProjectState.mockResolvedValue(project('1', 'Run a 5K', '🏃', 'backlog'));

    const { getByLabelText, getByText } = await renderScreen();
    await waitFor(() =>
      expect(getByLabelText('Project status: Next')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Project status: Next'));
    });
    expect(getByText('Project status')).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByText('Move to backlog'));
    });

    expect(mockSetProjectState).toHaveBeenCalledTimes(1);
    expect(mockSetProjectState.mock.calls[0][2]).toBe('backlog');
  });

  it('puts a backlog project back in play from its status', async () => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Run a 5K', '🏃', 'backlog'),
    ]);
    mockSetProjectState.mockResolvedValue(
      project('1', 'Run a 5K', '🏃', 'in-play'),
    );

    const { getByLabelText, getByText } = await renderScreen();
    await waitFor(() =>
      expect(getByLabelText('Project status: Backlog')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Project status: Backlog'));
    });
    await act(async () => {
      fireEvent.press(getByText('Move out of backlog'));
    });

    expect(mockSetProjectState).toHaveBeenCalledTimes(1);
    expect(mockSetProjectState.mock.calls[0][2]).toBe('in-play');
  });

  it('marks done immediately, pops, and offers Undo', async () => {
    mockSetProjectState.mockResolvedValue(project('1', 'ship', '📁', 'done'));
    const { getByLabelText, getByText } = await renderScreen();
    await waitFor(() =>
      expect(getByLabelText('Project status: Next')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Project status: Next'));
    });
    await act(async () => {
      fireEvent.press(getByText('Mark done'));
    });

    await waitFor(() =>
      expect(mockSetProjectState).toHaveBeenCalledWith(
        expect.anything(),
        '1',
        'done',
      ),
    );
    expect(mockBack).toHaveBeenCalledTimes(1);
    const toast = defaultToastController.getSnapshot()[0];
    expect(toast?.message).toBe('Project completed');
    expect(toast?.action?.label).toBe('Undo');
    await act(async () => toast?.action?.onPress());
    await waitFor(() =>
      expect(mockSetProjectState).toHaveBeenCalledWith(
        expect.anything(),
        '1',
        'in-play',
      ),
    );
  });

  it('keeps empty projects and their status sheet free of explanatory prompts', async () => {
    mockFetchTasks.mockResolvedValue([]);
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByLabelText('Project status: Next')).toBeTruthy());
    expect(screen.queryByText('No tasks yet')).toBeNull();
    expect(screen.queryByLabelText('Add first task')).toBeNull();
    expect(screen.queryByText('Tasks')).toBeNull();
    expect(screen.getByLabelText('Add')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Project status: Next'));
    expect(screen.queryByText(/update automatically/)).toBeNull();
    expect(screen.queryByText(/Backlog keeps/)).toBeNull();
    expect(screen.getByText('Move to backlog')).toBeTruthy();
    expect(screen.getByText('Mark done')).toBeTruthy();
  });

  it('keeps deletion in project settings without status controls', async () => {
    const { getByLabelText, getByText, queryByText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project settings')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Project settings'));
    });
    expect(getByText('Delete project')).toBeTruthy();
    expect(queryByText('Move to backlog')).toBeNull();
    expect(queryByText('Move out of backlog')).toBeNull();
    expect(queryByText('Mark done')).toBeNull();
    await act(async () => {
      fireEvent.press(getByText('Delete project'));
    });

    expect(mockDeleteProject).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenLastCalledWith(
      'Delete “Run a 5K”?', expect.stringContaining('including completed tasks'),
      expect.any(Array), { cancelable: true },
    );
    await act(async () => confirmDelete());
    await waitFor(() =>
      expect(mockDeleteProject).toHaveBeenCalledWith(expect.anything(), '1'),
    );
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('warns when deleting an After target may move another Project', async () => {
    mockFetchProjects.mockResolvedValue([
      project('1', 'Sell old house'),
      project('2', 'Move house'),
    ]);
    mockFetchWaits.mockResolvedValue([dependencyRow('dependency', '2', '1')]);
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByLabelText('Project settings')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Project settings'));
    await fireEvent.press(screen.getByText('Delete project'));

    expect(mockAlert).toHaveBeenLastCalledWith(
      'Delete “Sell old house”?',
      expect.stringContaining('“Move house” is after it and may move to another section.'),
      expect.any(Array),
      { cancelable: true },
    );
  });

  it('reports deletion failure globally after the screen has unmounted', async () => {
    let rejectDelete: (error: Error) => void = () => {};
    mockDeleteProject.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectDelete = reject; }));
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByLabelText('Project settings')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Project settings'));
    await fireEvent.press(screen.getByText('Delete project'));
    await act(async () => confirmDelete());
    await waitFor(() => expect(mockDeleteProject).toHaveBeenCalled());
    await screen.unmount();
    await act(async () => rejectDelete(new Error('terminal failure')));
    await waitFor(() => expect(defaultToastController.getSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Delete failed · Retry', durationMs: Infinity, description: undefined }),
    ])));
  });

  it('re-pulls tasks and waits after a delete so cascaded orphans disappear', async () => {
    const { getByLabelText, getByText } = await renderScreen();
    await waitFor(() => expect(getByLabelText('Project settings')).toBeTruthy());

    const tasksBefore = mockFetchTasks.mock.calls.length;
    const waitsBefore = mockFetchWaits.mock.calls.length;

    await act(async () => {
      fireEvent.press(getByLabelText('Project settings'));
    });
    await act(async () => {
      fireEvent.press(getByText('Delete project'));
    });

    await act(async () => confirmDelete());

    // The delete persists, then its .then re-pulls both dependent collections
    // (the server has cascaded their rows away).
    await waitFor(() =>
      expect(mockFetchTasks.mock.calls.length).toBeGreaterThan(tasksBefore),
    );
    await waitFor(() =>
      expect(mockFetchWaits.mock.calls.length).toBeGreaterThan(waitsBefore),
    );
  });

  it('re-pulls the project, tasks, and waits when the screen is pulled to refresh', async () => {
    const screen = await renderScreen();
    await waitFor(() =>
      expect(screen.getByLabelText('Project title').props.value).toBe('Run a 5K'),
    );

    const projectsBefore = mockFetchProjects.mock.calls.length;
    const tasksBefore = mockFetchTasks.mock.calls.length;
    const waitsBefore = mockFetchWaits.mock.calls.length;
    await act(async () => {
      pullToRefresh(screen);
    });

    await waitFor(() =>
      expect(mockFetchProjects.mock.calls.length).toBeGreaterThan(projectsBefore),
    );
    expect(mockFetchTasks.mock.calls.length).toBeGreaterThan(tasksBefore);
    expect(mockFetchWaits.mock.calls.length).toBeGreaterThan(waitsBefore);
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
