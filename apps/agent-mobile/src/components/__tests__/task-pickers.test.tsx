import { projectParent } from '@zero/agent-core';
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ProjectPickerSheet, ScheduleSheet } from '../task-detail';

const emptyAttention = { openTasks: [], conditions: [] };
const projects = Array.from({ length: 30 }, (_, i) => ({
  id: String(i), title: `Project ${i}`, icon: '📁', description: null,
  state: 'in-play' as const, createdAt: '2026-01-01',
}));
const statusProjects = [
  { ...projects[0], id: 'active', title: 'Active project' },
  { ...projects[0], id: 'next', title: 'Next project' },
  { ...projects[0], id: 'waiting', title: 'Waiting project' },
  { ...projects[0], id: 'after', title: 'After project' },
  { ...projects[0], id: 'target', title: 'Target project' },
  ...Array.from({ length: 6 }, (_, i) => ({
    ...projects[0], id: `backlog-${i}`, title: `Backlog ${i}`, state: 'backlog' as const,
  })),
];
const openTasks = [{
  id: 'active-task', text: 'Work', parent: projectParent('active'), showUpDate: '2000-01-01',
  recurrence: null, recurrenceDate: null,
  createdAt: '2026-01-01', completedAt: null, sortKey: null,
}];
const conditions = [
  { id: 'wait', projectId: 'waiting', kind: 'free-text' as const, text: 'Reply',
    refId: null, targetStatus: null, createdAt: '2026-01-01', resolvedAt: null },
  { id: 'after-link', projectId: 'after', kind: 'project-status' as const, text: null,
    refId: 'target', targetStatus: 'done' as const, createdAt: '2026-01-01', resolvedAt: null },
];

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
    const screen = await render(<ProjectPickerSheet open projects={projects} {...emptyAttention} selectedProjectId="1" onPick={onPick} onClose={() => {}} />);
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
        {...emptyAttention}
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
      ...emptyAttention,
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

  it('can hide No project and show an unfiltered After empty state', async () => {
    const screen = await render(
      <ProjectPickerSheet
        open
        title="After project"
        projects={[]}
        {...emptyAttention}
        selectedProjectId={null}
        showNoProject={false}
        emptyCopy="No available projects"
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('After project')).toBeTruthy();
    expect(screen.queryByLabelText('No project')).toBeNull();
    expect(screen.getByText('No available projects')).toBeTruthy();
  });

  it('orders status sections and folds After and Backlog', async () => {
    const onPick = jest.fn();
    const screen = await render(<ProjectPickerSheet open projects={statusProjects}
      openTasks={openTasks} conditions={conditions} selectedProjectId={null}
      onPick={onPick} onClose={() => {}} />);
    const headers = screen.getAllByRole('button').filter((node) => node.props.accessibilityState?.expanded !== undefined);
    expect(headers.map((node) => node.props.accessibilityLabel)).toEqual([
      'Active, 1', 'Next, 2', 'Waiting, 1', 'After, 1', 'Backlog, 6',
    ]);
    expect(screen.getByLabelText('After, 1').props.accessibilityState.expanded).toBe(false);
    expect(screen.getByLabelText('Backlog, 6').props.accessibilityState.expanded).toBe(false);
    expect(screen.queryByLabelText('Backlog 0')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Backlog, 6'));
    await fireEvent.press(screen.getByLabelText('Backlog 0'));
    expect(onPick).toHaveBeenCalledWith('backlog-0');
  });

  it('reveals a folded Backlog match when filtering', async () => {
    const screen = await render(<ProjectPickerSheet open projects={statusProjects}
      openTasks={openTasks} conditions={conditions} selectedProjectId={null}
      onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText('Backlog, 6').props.accessibilityState.expanded).toBe(false);
    await fireEvent.changeText(screen.getByLabelText('Filter projects'), 'backlog 5');
    expect(screen.getByLabelText('Backlog, 1').props.accessibilityState.expanded).toBe(true);
    expect(screen.getByLabelText('Backlog 5')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Filter projects'), '');
    expect(screen.getByLabelText('Backlog, 6').props.accessibilityState.expanded).toBe(false);
  });

  it('restores a manual fold after search and starts fresh on reopening', async () => {
    const props = { projects: statusProjects, openTasks, conditions,
      selectedProjectId: null, onPick: () => {}, onClose: () => {} };
    const screen = await render(<ProjectPickerSheet {...props} open />);
    await fireEvent.press(screen.getByLabelText('Backlog, 6'));
    expect(screen.getByLabelText('Backlog, 6').props.accessibilityState.expanded).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Filter projects'), 'backlog 5');
    await fireEvent.changeText(screen.getByLabelText('Filter projects'), '');
    expect(screen.getByLabelText('Backlog, 6').props.accessibilityState.expanded).toBe(true);
    await screen.rerender(<ProjectPickerSheet {...props} open={false} />);
    await screen.rerender(<ProjectPickerSheet {...props} open />);
    expect(screen.getByLabelText('Backlog, 6').props.accessibilityState.expanded).toBe(false);
  });

  it('lists only eligible After targets and still derives their status from all Projects', async () => {
    const onPick = jest.fn();
    const screen = await render(<ProjectPickerSheet open title="After project"
      projects={statusProjects} afterSourceProjectId="next"
      openTasks={openTasks} conditions={conditions} selectedProjectId={null}
      showNoProject={false} onPick={onPick} onClose={() => {}} />);
    expect(screen.getByLabelText('Active, 1')).toBeTruthy();
    expect(screen.getByLabelText('After, 1')).toBeTruthy();
    expect(screen.queryByLabelText('Next project')).toBeNull();
    await fireEvent.press(screen.getByLabelText('After, 1'));
    await fireEvent.press(screen.getByLabelText('After project'));
    expect(onPick).toHaveBeenCalledWith('after');
  });

  it('marks No project as selected for a loose task', async () => {
    const screen = await render(<ProjectPickerSheet open projects={[]} {...emptyAttention} selectedProjectId={null} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('No project').props.accessibilityState).toEqual({ selected: true }));
    expect(screen.getByText('✓')).toBeTruthy();
  });
});
