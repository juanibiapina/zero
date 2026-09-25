import { strict as assert } from 'node:assert';
import { createMergeableStore } from 'tinybase';

const a = createMergeableStore();
a.setRow('tasks', 'task', { text: 'Original', createdAt: '2026-09-25T00:00:00Z' });
const b = createMergeableStore().merge(a);
a.setCell('tasks', 'task', 'text', 'Offline edit A');
b.setCell('tasks', 'task', 'text', 'Offline edit B');
const before = [a.getCell('tasks', 'task', 'text'), b.getCell('tasks', 'task', 'text')];
a.merge(b);
b.merge(a);
assert.equal(a.getCell('tasks', 'task', 'text'), b.getCell('tasks', 'task', 'text'));
const winner = a.getCell('tasks', 'task', 'text');
const loser = before.find((value) => value !== winner);
assert.ok(loser, 'both edits must differ');
assert.equal(JSON.stringify(a.getContent()).includes(String(loser)), false,
  'the losing edit is absent from the merged dataset');
console.log(JSON.stringify({ winner, lost: loser, rows: a.getContent() }));

// Candidate representation: each official edit gets a unique immutable row.
// No client writes the Task's text cell after creation. Two edits from the same
// base are both retained, even though the accepted text still needs a winner.
const c = createMergeableStore();
c.setRow('tasks', 'task', { text: 'Original', createdAt: '2026-09-25T00:00:00Z' });
const d = createMergeableStore().merge(c);
c.setRow('task-edits', 'edit-a', { taskId: 'task', baseRevision: 'original', text: 'Offline edit A' });
d.setRow('task-edits', 'edit-b', { taskId: 'task', baseRevision: 'original', text: 'Offline edit B' });
c.merge(d);
d.merge(c);
assert.deepEqual(c.getTable('task-edits'), d.getTable('task-edits'));
assert.deepEqual(Object.values(c.getTable('task-edits')).map((row) => row.text).sort(),
  ['Offline edit A', 'Offline edit B']);
console.log(JSON.stringify({ candidate: 'append-only edits', edits: c.getTable('task-edits') }));
