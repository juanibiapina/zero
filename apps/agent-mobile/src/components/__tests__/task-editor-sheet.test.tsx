import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Text as RNText } from 'react-native';
import { AddModeSelector, TaskEditorSheet } from '../task-editor-sheet';

const base = {
  open: true,
  dismissLabel: 'Close task',
  draft: 'Write proposal',
  onChangeDraft: jest.fn(),
  onSubmit: jest.fn(),
  onClose: jest.fn(),
};

describe('TaskEditorSheet', () => {
  it('reports keyboard dismissal while the inline editor is open', async () => {
    const onKeyboardWillHide = jest.fn();
    const view = await render(
      <TaskEditorSheet
        {...base}
        inline
        onKeyboardWillHide={onKeyboardWillHide}
      />,
    );

    await act(async () => {
      (global as typeof globalThis & {
        __emitKeyboardEvent: (name: string) => void;
      }).__emitKeyboardEvent('keyboardWillHide');
    });
    expect(onKeyboardWillHide).toHaveBeenCalledTimes(1);

    await view.rerender(
      <TaskEditorSheet
        {...base}
        open={false}
        inline
        onKeyboardWillHide={onKeyboardWillHide}
      />,
    );
    await act(async () => {
      (global as typeof globalThis & {
        __emitKeyboardEvent: (name: string) => void;
      }).__emitKeyboardEvent('keyboardWillHide');
    });
    expect(onKeyboardWillHide).toHaveBeenCalledTimes(1);
  });

  it('uses one persistent collapsed control to open the inline editor', async () => {
    const open = jest.fn();
    const view = await render(
      <TaskEditorSheet
        {...base}
        open={false}
        inline
        autoFocus
        onOpen={open}
        collapsedFabLabel="Task"
      />,
    );

    expect(
      view.getByTestId('task-edit-input', { includeHiddenElements: true }).props
        .autoFocus,
    ).toBe(false);
    await fireEvent.press(view.getByLabelText('Task'));
    expect(open).toHaveBeenCalledTimes(1);

    await view.rerender(
      <TaskEditorSheet
        {...base}
        inline
        autoFocus
        onOpen={open}
        collapsedFabLabel="Task"
      />,
    );
    expect(view.queryByLabelText('Task')).toBeNull();
    expect(view.getByDisplayValue('Write proposal').props.autoFocus).toBe(true);
  });

  it('does not block a separate FAB when its inline editor is closed', async () => {
    const view = await render(
      <TaskEditorSheet {...base} open={false} inline />,
    );

    expect(
      view.getByTestId('task-editor-morph-shell', {
        includeHiddenElements: true,
      }).props.pointerEvents,
    ).toBe('none');
  });

  it('measures the expanded content outside the collapsed shell constraint', async () => {
    const view = await render(
      <TaskEditorSheet
        {...base}
        open={false}
        inline
        onOpen={jest.fn()}
        collapsedFabLabel="Task"
        scheduleAction={{ label: 'No date', active: false, onPress: jest.fn() }}
        projectAction={{ label: 'No project', active: false, onPress: jest.fn() }}
      />,
    );

    expect(
      view.getByTestId('task-editor-morph-content', {
        includeHiddenElements: true,
      }).props.style,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ position: 'absolute', top: 0 }),
    ]));
  });

  it('shows the drawer grip and project icon once, then opens both metadata pickers', async () => {
    const schedule = jest.fn();
    const project = jest.fn();
    const view = await render(
      <TaskEditorSheet {...base}
        scheduleAction={{ label: 'No date', active: false, onPress: schedule }}
        projectAction={{ label: 'Launch', icon: '🎯', active: true, onPress: project }}
      />,
    );
    expect(view.getByTestId('task-editor-grip')).toBeTruthy();
    expect(view.getAllByText('🎯 Launch')).toHaveLength(1);
    expect(view.queryByText('📁')).toBeNull();
    expect(view.queryByText('🗓')).toBeNull();
    await fireEvent.press(view.getByLabelText('No date'));
    await fireEvent.press(view.getByLabelText('Launch'));
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledTimes(1);
    expect(view.getByDisplayValue('Write proposal').props.autoFocus).toBe(false);
  });

  it('keeps project assignment and its icon-only jump action independent', async () => {
    const assign = jest.fn();
    const jump = jest.fn();
    const view = await render(
      <TaskEditorSheet
        {...base}
        projectAction={{
          label: 'Launch',
          icon: '🎯',
          active: true,
          onPress: assign,
          trailingAction: {
            icon: <RNText>jump</RNText>,
            accessibilityLabel: 'Open project Launch',
            onPress: jump,
          },
        }}
      />,
    );

    await fireEvent.press(view.getByLabelText('Open project Launch'));
    expect(jump).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();

    await fireEvent.press(view.getByLabelText('Launch'));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it('offers unset metadata rows and focuses the in-tree create field on mount', async () => {
    const view = await render(
      <TaskEditorSheet {...base} inline autoFocus
        scheduleAction={{ label: 'No date', active: false, onPress: jest.fn() }}
        projectAction={{ label: 'No project', active: false, onPress: jest.fn() }}
      />,
    );
    expect(view.getByLabelText('No project')).toBeTruthy();
    expect(view.getByLabelText('No date')).toBeTruthy();
    expect(view.getByDisplayValue('Write proposal').props.autoFocus).toBe(true);
  });

  it('highlights parser-consumed schedule text in a quick-add draft', async () => {
    const dismiss = jest.fn();
    const view = await render(
      <TaskEditorSheet
        {...base}
        draft="Stand up every day"
        highlightRanges={[{ start: 9, end: 18, text: 'every day' }]}
        onDismissHighlight={dismiss}
      />,
    );

    expect(
      view.getByTestId('schedule-highlight', { includeHiddenElements: true }).props
        .children,
    ).toBe('every day');
    expect(view.getByDisplayValue('Stand up every day')).toBeTruthy();
  });

  it('offers four accessible Project modes with one selected mode', async () => {
    const change = jest.fn();
    const modes = ['task', 'waiting', 'after', 'project'] as const;
    const view = await render(
      <TaskEditorSheet {...base} modeSelector={
        <AddModeSelector mode="waiting" modes={[...modes]} onModeChange={change} />
      } />,
    );

    for (const label of [
      'Add a task',
      'Add a waiting condition',
      'Add an After project',
      'Add a project',
    ]) {
      expect(view.getByLabelText(label)).toBeTruthy();
    }
    expect(
      view.getByLabelText('Add a waiting condition').props.accessibilityState
        .selected,
    ).toBe(true);
    await fireEvent.press(view.getByLabelText('Add an After project'));
    expect(change).toHaveBeenCalledWith('after');
    expect(view.queryByLabelText('No date')).toBeNull();
    expect(view.queryByLabelText('No project')).toBeNull();
  });
});
