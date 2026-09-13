import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ProjectPickerSheet, ScheduleSheet } from '../task-detail';

const projects = Array.from({ length: 30 }, (_, i) => ({
  id: String(i), title: `Project ${i}`, icon: '📁', description: null,
  status: 'next' as const, createdAt: '2026-01-01',
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

  it('marks No project as selected for a loose task', async () => {
    const screen = await render(<ProjectPickerSheet open projects={[]} selectedProjectId={null} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('No project').props.accessibilityState).toEqual({ selected: true }));
    expect(screen.getByText('✓')).toBeTruthy();
  });
});
