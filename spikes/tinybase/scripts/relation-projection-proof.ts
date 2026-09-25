import { strict as assert } from 'node:assert';
import { createMergeableStore, type MergeableStore } from 'tinybase';

// Exploratory domain projection: not the complete Task/Project model.
function project(store: MergeableStore) {
  const projects = store.getTable('projects');
  const tasks = Object.entries(store.getTable('tasks')).map(([id, row]) => {
    const projectId = typeof row.projectId === 'string' ? row.projectId : null;
    const parent = projectId ? projects[projectId] : undefined;
    return {
      id,
      text: row.text,
      projectId: parent && !parent.deletedAt ? projectId : null,
      recovery: projectId && !parent ? 'missing-project' : parent?.deletedAt ? 'deleted-project' : null,
    };
  });

  const accepted: string[] = [];
  const blocked: string[] = [];
  const adjacency = new Map<string, string[]>();
  for (const [id, row] of Object.entries(store.getTable('afters')).sort(([a], [b]) => a.localeCompare(b))) {
    const source = row.projectId;
    const target = row.refId;
    if (typeof source !== 'string' || typeof target !== 'string' || !projects[source] || !projects[target]
      || projects[source].deletedAt || projects[target].deletedAt) {
      blocked.push(id);
      continue;
    }
    const pending = [target];
    const seen = new Set<string>();
    let cycle = false;
    while (pending.length) {
      const current = pending.pop()!;
      if (current === source) { cycle = true; break; }
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
    if (cycle) { blocked.push(id); continue; }
    adjacency.set(source, [...(adjacency.get(source) ?? []), target]);
    accepted.push(id);
  }
  return { tasks, accepted, blocked };
}

const a = createMergeableStore();
a.setRow('projects', 'p', { title: 'Old project' });
a.setRow('tasks', 'existing', { text: 'previous work', projectId: 'p' });
a.setRow('projects', 'x', { title: 'X' });
a.setRow('projects', 'y', { title: 'Y' });
const b = createMergeableStore().merge(a);

// While disconnected, A deletes its known child and marks the Project deleted.
a.setCell('projects', 'p', 'deletedAt', '2026-09-25T12:00:00Z');
a.delRow('tasks', 'existing');
a.setRow('afters', 'a', { projectId: 'x', refId: 'y' });
// B has not seen the deletion. It creates a child and a conflicting After.
b.setRow('tasks', 'late', { text: 'offline work', projectId: 'p' });
b.setRow('tasks', 'invalid', { text: 'bad raw ref', projectId: 'nonexistent' });
b.setRow('afters', 'b', { projectId: 'y', refId: 'x' });
a.merge(b);
b.merge(a);
assert.deepEqual(project(a), project(b));
assert.equal(a.hasRow('tasks', 'existing'), false);
assert.equal(project(a).tasks.find((task) => task.id === 'late')?.recovery, 'deleted-project');
assert.equal(project(a).tasks.find((task) => task.id === 'invalid')?.recovery, 'missing-project');
assert.deepEqual(project(a).accepted, ['a']);
assert.deepEqual(project(a).blocked, ['b']);
console.log(JSON.stringify(project(a)));
