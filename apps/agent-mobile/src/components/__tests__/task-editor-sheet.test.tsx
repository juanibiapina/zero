import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
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

  it('offers unset metadata rows and autofocuses only when requested', async () => {
    const view = await render(
      <TaskEditorSheet {...base} autoFocus
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

  it('offers Task and Project modes without task metadata in Project mode', async () => {
    const change = jest.fn();
    const view = await render(
      <TaskEditorSheet {...base} modeSelector={
        <AddModeSelector mode="project" modes={['task', 'project']} onModeChange={change} />
      } />,
    );
    await fireEvent.press(view.getByLabelText('Add a task'));
    expect(change).toHaveBeenCalledWith('task');
    expect(view.getByLabelText('Add a project').props.accessibilityState.selected).toBe(true);
    expect(view.queryByLabelText('No date')).toBeNull();
    expect(view.queryByLabelText('No project')).toBeNull();
  });
});
