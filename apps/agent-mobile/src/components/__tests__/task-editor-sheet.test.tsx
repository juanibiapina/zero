import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { TaskEditorSheet, ModePills } from '../task-editor-sheet';

const base = {
  open: true,
  dismissLabel: 'Close task',
  draft: 'Write proposal',
  onChangeDraft: jest.fn(),
  onSubmit: jest.fn(),
  onClose: jest.fn(),
};

describe('TaskEditorSheet', () => {
  it('shows the project icon once and opens both metadata pickers', async () => {
    const schedule = jest.fn();
    const project = jest.fn();
    const view = await render(
      <TaskEditorSheet {...base}
        dateChip={{ label: 'No date', active: false, onPress: schedule }}
        projectChip={{ label: 'Launch', icon: '🎯', active: true, onPress: project }}
      />,
    );
    expect(view.getAllByText('🎯 Launch')).toHaveLength(1);
    expect(view.queryByText('📁')).toBeNull();
    expect(view.queryByText('🗓')).toBeNull();
    await fireEvent.press(view.getByLabelText('No date'));
    await fireEvent.press(view.getByLabelText('Launch'));
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledTimes(1);
    expect(view.getByDisplayValue('Write proposal').props.autoFocus).toBe(false);
  });

  it('offers unset chips and autofocuses only when requested', async () => {
    const view = await render(
      <TaskEditorSheet {...base} autoFocus
        dateChip={{ label: 'No date', active: false, onPress: jest.fn() }}
        projectChip={{ label: 'No project', active: false, onPress: jest.fn() }}
      />,
    );
    expect(view.getByLabelText('No project')).toBeTruthy();
    expect(view.getByLabelText('No date')).toBeTruthy();
    expect(view.getByDisplayValue('Write proposal').props.autoFocus).toBe(true);
  });

  it('offers the configured create modes without task metadata for other types', async () => {
    const change = jest.fn();
    const view = await render(
      <TaskEditorSheet {...base} pills={
        <ModePills mode="project" modes={['task', 'project', 'waiting']} onModeChange={change} />
      } />,
    );
    await fireEvent.press(view.getByLabelText('Add a waiting condition'));
    expect(change).toHaveBeenCalledWith('waiting');
    expect(view.getByLabelText('Add a project').props.accessibilityState.selected).toBe(true);
    expect(view.queryByLabelText('No date')).toBeNull();
    expect(view.queryByLabelText('No project')).toBeNull();
  });
});
