import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ProjectPickerSheet } from '../task-detail';

const projects = Array.from({ length: 30 }, (_, i) => ({
  id: String(i), title: `Project ${i}`, icon: '📁', description: null,
  status: 'next' as const, createdAt: '2026-01-01',
}));

describe('task pickers', () => {
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
