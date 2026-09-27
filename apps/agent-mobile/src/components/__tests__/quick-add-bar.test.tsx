import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';

import { QuickAddBar } from '../quick-add-bar';

describe('QuickAddBar', () => {
  it('renders the input and add button', async () => {
    const { getByPlaceholderText, getByLabelText } = await render(
      <QuickAddBar value="" onChangeText={() => {}} onSubmit={() => {}} />,
    );
    expect(getByPlaceholderText('Add a task')).toBeTruthy();
    expect(getByLabelText('Task')).toBeTruthy();
  });

  it('offers task and project pills when a mode is set', async () => {
    const onModeChange = jest.fn();
    const { getByLabelText } = await render(
      <QuickAddBar
        value=""
        mode="project"
        onModeChange={onModeChange}
        onChangeText={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(getByLabelText('Add a task')).toBeTruthy();
    const project = getByLabelText('Add a project');
    expect(project).toBeTruthy();

    fireEvent.press(getByLabelText('Add a task'));
    expect(onModeChange).toHaveBeenCalledWith('task');
  });

  it('offers only the modes it is given, still interactive', async () => {
    const onModeChange = jest.fn();
    const { getByLabelText, queryByLabelText } = await render(
      <QuickAddBar
        value=""
        mode="task"
        modes={['task']}
        onModeChange={onModeChange}
        onChangeText={() => {}}
        onSubmit={() => {}}
      />,
    );

    // The Task pill is present and pressable (reads exactly like Home's)…
    const task = getByLabelText('Add a task');
    expect(task).toBeTruthy();
    fireEvent.press(task);
    expect(onModeChange).toHaveBeenCalledWith('task');
    // …but it is the only pill: Project is not offered.
    expect(queryByLabelText('Add a project')).toBeNull();
  });

  it('derives the placeholder from the selected mode', async () => {
    const { getByPlaceholderText } = await render(
      <QuickAddBar
        value=""
        mode="project"
        onModeChange={() => {}}
        onChangeText={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(getByPlaceholderText('Name an outcome')).toBeTruthy();
  });

  it('submits on the add button and on the keyboard done key', async () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByPlaceholderText } = await render(
      <QuickAddBar value="buy milk" onChangeText={() => {}} onSubmit={onSubmit} />,
    );

    fireEvent.press(getByLabelText('Task'));
    fireEvent(getByPlaceholderText('Add a task'), 'submitEditing');

    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
