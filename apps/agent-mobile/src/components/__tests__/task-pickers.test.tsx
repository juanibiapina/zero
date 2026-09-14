import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ProjectPickerSheet, ScheduleSheet } from '../task-detail';

const projects = Array.from({ length: 30 }, (_, i) => ({
  id: String(i), title: `Project ${i}`, icon: '📁', description: null,
  state: 'in-play' as const, createdAt: '2026-01-01',
}));

describe('task pickers', () => {
  it('reopens the calendar at the selected month instead of the browsed month', async () => {
    const props = { showUpDate: '2026-09-13', onPick: () => {}, onClose: () => {} };
    const screen = await render(<ScheduleSheet {...props} open />);
    await fireEvent.press(screen.getByLabelText('Next month'));
    expect(screen.getByText('October 2026')).toBeTruthy();
    await screen.rerender(<ScheduleSheet {...props} open={false} />);
    await screen.rerender(<ScheduleSheet {...props} open />);
    expect(screen.getByText('September 2026')).toBeTruthy();
    const date = screen.getByTestId('schedule-date-2026-09-13');
    expect(date.props.accessibilityState).toEqual({ selected: true });
    expect(date.props.accessibilityLabel).toContain('September');
    await screen.rerender(<ScheduleSheet {...props} open={false} />);
    await screen.rerender(<ScheduleSheet {...props} showUpDate="2027-01-04" open />);
    expect(screen.getByText('January 2027')).toBeTruthy();
  });

  it('marks the current project and selects a visible project', async () => {
    const onPick = jest.fn();
    const screen = await render(<ProjectPickerSheet open projects={projects} selectedProjectId="1" onPick={onPick} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Project 1' }).props.accessibilityState).toEqual({ selected: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Project 2' }));
    expect(onPick).toHaveBeenCalledWith('2');
    await fireEvent.press(screen.getByRole('button', { name: 'No project' }));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('filters project titles while keeping No project reachable', async () => {
    const onPick = jest.fn();
    const screen = await render(
      <ProjectPickerSheet
        open
        projects={projects}
        selectedProjectId="1"
        onPick={onPick}
        onClose={() => {}}
      />,
    );

    await fireEvent.changeText(screen.getByLabelText('Filter projects'), 'PROJECT 29');
    expect(screen.getByLabelText('Project 29')).toBeTruthy();
    expect(screen.queryByLabelText('Project 28')).toBeNull();
    expect(screen.getByLabelText('No project')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Project 29'));
    expect(onPick).toHaveBeenCalledWith('29');
  });

  it('reports no matches and clears the filter on the next opening', async () => {
    const props = {
      projects,
      selectedProjectId: null,
      onPick: () => {},
      onClose: () => {},
    };
    const screen = await render(<ProjectPickerSheet {...props} open />);

    await fireEvent.changeText(screen.getByLabelText('Filter projects'), 'missing');
    expect(screen.getByText('No matching projects')).toBeTruthy();
    await screen.rerender(<ProjectPickerSheet {...props} open={false} />);
    await screen.rerender(<ProjectPickerSheet {...props} open />);

    expect(screen.getByLabelText('Filter projects').props.value).toBe('');
    expect(screen.getByLabelText('Project 0')).toBeTruthy();
  });

  it('marks No project as selected for a loose task', async () => {
    const screen = await render(<ProjectPickerSheet open projects={[]} selectedProjectId={null} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('No project').props.accessibilityState).toEqual({ selected: true }));
    expect(screen.getByText('✓')).toBeTruthy();
  });
});
