import type { Project, ProjectAttention, Task } from '@zero/agent-core';
import { validateRecurrence } from '@zeroapps/recurrence';
import type { MergeableStore } from 'tinybase';

export type Recovery = { table: 'tasks' | 'projects' | 'conditions'; id: string; text: string; reason: string };
export type FixtureSnapshot = { tasks: Task[]; projects: Project[]; conditions: ProjectAttention[]; recoveries: Recovery[] };

export function projectText(store: MergeableStore, taskId: string, original: string) {
  const all = Object.entries(store.getTable('task-edits')).filter(([, row]) => row.taskId === taskId);
  const edits = all.filter(([, row]) => typeof row.baseRevision === 'string' && typeof row.text === 'string');
  let revision = 'original';
  let text = original;
  const path = new Set<string>();
  while (true) {
    const children = edits.filter(([, row]) => row.baseRevision === revision)
      .sort(([a], [b]) => a.localeCompare(b));
    const next = children.at(-1);
    if (!next || path.has(next[0])) break;
    path.add(next[0]);
    revision = next[0];
    text = next[1].text as string;
  }
  const allIds = new Set(edits.map(([id]) => id));
  return { text, revision, conflicts: all.filter(([id]) => !path.has(id)).map(([id, row]) => ({
    table: 'tasks' as const, id: taskId, text: typeof row.text === 'string' ? row.text : id,
    reason: `Edit ${id}: ${row.baseRevision === 'original' || allIds.has(String(row.baseRevision))
      ? 'Concurrent edit' : 'Orphaned edit'}`,
  })) };
}

export function projectFixture(store: MergeableStore): FixtureSnapshot {
  const recoveries: Recovery[] = [];
  const projectsById = new Map<string, Project>();
  for (const [id, row] of Object.entries(store.getTable('projects'))) {
    if (row.deletedAt) continue;
    if (typeof row.title !== 'string' || typeof row.createdAt !== 'string' ||
      (row.state !== 'in-play' && row.state !== 'backlog' && row.state !== 'done')) {
      recoveries.push({ table: 'projects', id, text: typeof row.title === 'string' ? row.title : id, reason: 'Invalid Project' });
      continue;
    }
    projectsById.set(id, { id, title: row.title, createdAt: row.createdAt,
      icon: typeof row.icon === 'string' ? row.icon : '📁',
      description: typeof row.description === 'string' ? row.description : null,
      state: row.state, sourceCaptureId: typeof row.sourceCaptureId === 'string' ? row.sourceCaptureId : null });
  }
  const tasks: Task[] = [];
  for (const [id, row] of Object.entries(store.getTable('tasks'))) {
    const rawProjectId = typeof row.projectId === 'string' ? row.projectId : null;
    if (rawProjectId && !projectsById.has(rawProjectId)) {
      recoveries.push({ table: 'tasks', id, text: typeof row.text === 'string' ? row.text : id,
        reason: store.getCell('projects', rawProjectId, 'deletedAt') ? 'Deleted Project' : 'Missing Project' });
    }
    if (typeof row.text !== 'string' || typeof row.createdAt !== 'string') {
      recoveries.push({ table: 'tasks', id, text: typeof row.text === 'string' ? row.text : id, reason: 'Invalid Task' });
      continue;
    }
    const acceptedText = projectText(store, id, row.text);
    recoveries.push(...acceptedText.conflicts);
    let recurrence: Task['recurrence'] = null;
    if (row.recurrence !== undefined) {
      try {
        const result = validateRecurrence(JSON.parse(String(row.recurrence)));
        if (result.ok) recurrence = result.value;
      } catch { /* Recovery report below retains the raw value. */ }
      if (!recurrence) recoveries.push({ table: 'tasks', id, text: row.text, reason: 'Invalid recurrence' });
    }
    if (!row.completedAt) tasks.push({ id, text: acceptedText.text, createdAt: row.createdAt,
      completedAt: null, showUpDate: typeof row.showUpDate === 'string' ? row.showUpDate : null,
      recurrence, recurrenceDate: typeof row.recurrenceDate === 'string' ? row.recurrenceDate : null,
      projectId: rawProjectId && projectsById.has(rawProjectId) ? rawProjectId : null,
      sourceCaptureId: typeof row.sourceCaptureId === 'string' ? row.sourceCaptureId : null,
      sortKey: typeof row.sortKey === 'string' ? row.sortKey : null });
  }
  for (const [id, row] of Object.entries(store.getTable('task-edits'))) {
    if (typeof row.taskId === 'string' && !store.hasRow('tasks', row.taskId)) {
      recoveries.push({ table: 'tasks', id: row.taskId,
        text: typeof row.text === 'string' ? row.text : id, reason: `Orphaned edit ${id}` });
    }
  }
  const conditions: ProjectAttention[] = [];
  const edges: { source: string; target: string }[] = [];
  const reaches = (source: string, destination: string): boolean => {
    const pending = [source];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === destination) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...edges.filter((edge) => edge.source === current).map((edge) => edge.target));
    }
    return false;
  };
  for (const [id, row] of Object.entries(store.getTable('conditions')).sort(([a], [b]) => a.localeCompare(b))) {
    const source = typeof row.projectId === 'string' ? row.projectId : null;
    const target = typeof row.refId === 'string' ? row.refId : null;
    const text = typeof row.text === 'string' ? row.text : id;
    const conflict = (reason: string) => recoveries.push({ table: 'conditions', id, text, reason });
    if (!source || typeof row.createdAt !== 'string' ||
      (row.resolvedAt !== undefined && typeof row.resolvedAt !== 'string')) { conflict('Invalid condition'); continue; }
    if (!projectsById.has(source)) { conflict('Missing source Project'); continue; }
    if (row.kind === 'free-text') {
      if (typeof row.text !== 'string' || !row.text.trim() || target || row.targetStatus) {
        conflict('Invalid Waiting condition');
      } else if (!row.resolvedAt) {
        conditions.push({ id, projectId: source, kind: 'free-text', text: row.text,
          refId: null, targetStatus: null, resolvedAt: null, createdAt: row.createdAt });
      }
      continue;
    }
    if (row.kind !== 'project-status' || !target || row.targetStatus !== 'done' || row.text) {
      conflict('Invalid After relationship'); continue;
    }
    const targetProject = projectsById.get(target);
    if (!targetProject) { conflict('Missing target Project'); continue; }
    if (source === target) { conflict('Self After relationship'); continue; }
    if (row.resolvedAt) continue;
    if (targetProject.state === 'done') { conflict('Target Project is Done'); continue; }
    if (edges.some((edge) => edge.source === source && edge.target === target)) { conflict('Duplicate After relationship'); continue; }
    if (reaches(target, source)) { conflict('Cyclic After relationship'); continue; }
    edges.push({ source, target });
    conditions.push({ id, projectId: source, kind: 'project-status', text: null,
      refId: target, targetStatus: 'done', resolvedAt: null, createdAt: row.createdAt });
  }
  tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { tasks, projects: [...projectsById.values()].filter((project) => project.state !== 'done'),
    conditions: conditions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), recoveries };
}
