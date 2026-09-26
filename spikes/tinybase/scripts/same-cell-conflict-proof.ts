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
