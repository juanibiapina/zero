import { describe, expect, it } from '@jest/globals';
import { createMergeableStore } from 'tinybase';

import { projectTodoData, repairTodoRecovery } from '../taskdo-projection';

const createdAt = '2026-09-25T12:00:00.000Z';
const project = (title: string) => ({ title, createdAt, state: 'in-play', icon: '📁' });

describe('local todo projection', () => {
  it('keeps a late offline child visible and labels its deleted Project link', () => {
    const server = createMergeableStore();
    server.setRow('projects', 'p', project('Project'));
    const offline = createMergeableStore().merge(server);
    server.setCell('projects', 'p', 'deletedAt', createdAt);
    offline.setRow('tasks', 'late', { text: 'Do not lose', createdAt, projectId: 'p' });
    server.merge(offline);
    offline.merge(server);
    expect(projectTodoData(server)).toEqual(projectTodoData(offline));
    expect(projectTodoData(server).tasks).toMatchObject([{ id: 'late', text: 'Do not lose', projectId: null }]);
    expect(projectTodoData(server).recoveries).toContainEqual({
      table: 'tasks', id: 'late', text: 'Do not lose', reason: 'Deleted Project',
      repair: 'make-task-loose',
    });
    expect(server.getCell('tasks', 'late', 'projectId')).toBe('p');
  });

  it('chooses the same acyclic Afters and exposes invalid raw rows on both peers', () => {
    const a = createMergeableStore();
    a.setRow('projects', 'x', project('X'));
    a.setRow('projects', 'y', project('Y'));
    const b = createMergeableStore().merge(a);
    a.setRow('conditions', 'a', {
      kind: 'project-status', projectId: 'x', refId: 'y', targetStatus: 'done', createdAt,
    });
    b.setRow('conditions', 'b', {
      kind: 'project-status', projectId: 'y', refId: 'x', targetStatus: 'done', createdAt,
    });
    b.setRow('projects', 'bad', { title: 'Needs repair' });
    a.merge(b);
    b.merge(a);
    expect(projectTodoData(a)).toEqual(projectTodoData(b));
    expect(projectTodoData(a).conditions.map((row) => row.id)).toEqual(['a']);
    expect(projectTodoData(a).recoveries).toContainEqual({
      table: 'conditions', id: 'b', text: 'b', reason: 'Cyclic After relationship',
      repair: 'remove-after',
    });
    expect(projectTodoData(a).recoveries).toContainEqual({
      table: 'projects', id: 'bad', text: 'Needs repair', reason: 'Invalid Project',
    });
  });

  it('retains invalid recurrence intent while showing the Task and a recovery reason', () => {
    const store = createMergeableStore();
    store.setRow('tasks', 'invalid', { text: 'Work', createdAt, recurrence: '{broken' });
    const snapshot = projectTodoData(store);
    expect(snapshot.tasks).toMatchObject([{ id: 'invalid', recurrence: null }]);
    expect(snapshot.recoveries).toContainEqual({
      table: 'tasks', id: 'invalid', text: 'Work', reason: 'Invalid recurrence',
      repair: 'clear-task-recurrence',
    });
    expect(store.getCell('tasks', 'invalid', 'recurrence')).toBe('{broken');
  });

  it('repairs only the still-matching recovery without dropping the Task row', () => {
    const store = createMergeableStore();
    store.setRow('projects', 'deleted', { ...project('Old'), deletedAt: createdAt });
    store.setRow('tasks', 'late', {
      text: 'Keep this', createdAt, projectId: 'deleted', recurrence: '{broken', recurrenceDate: '2026-10-01',
    });
    const [relationship, recurrence] = projectTodoData(store).recoveries;
    expect(repairTodoRecovery(store, relationship)).toBe(true);
    expect(store.getRow('tasks', 'late')).toMatchObject({ text: 'Keep this', recurrence: '{broken' });
    expect(store.hasCell('tasks', 'late', 'projectId')).toBe(false);
    expect(repairTodoRecovery(store, relationship)).toBe(false);
    expect(repairTodoRecovery(store, recurrence)).toBe(true);
    expect(store.getRow('tasks', 'late')).toMatchObject({ text: 'Keep this' });
    expect(store.hasCell('tasks', 'late', 'recurrence')).toBe(false);
    expect(store.hasCell('tasks', 'late', 'recurrenceDate')).toBe(false);
  });
});
