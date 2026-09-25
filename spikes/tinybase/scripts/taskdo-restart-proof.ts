import assert from 'node:assert/strict';
import { createMergeableStore } from 'tinybase';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import WebSocket from 'ws';

const base = process.env.TASKDO_PROOF_ORIGIN ?? 'http://127.0.0.1:8787';
const [phase, user] = process.argv.slice(2);
if (!['seed', 'verify'].includes(phase) || !/^taskdo-proof-[a-z0-9-]+$/.test(user ?? '')) {
  throw new Error('Usage: taskdo-restart-proof.ts seed|verify taskdo-proof-<unique-id>');
}
const headers = { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
async function req(path: string, method = 'GET', body?: object) {
  const response = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: response.status, data: response.status === 204 ? {} : await response.json() as any };
}
const until = async (predicate: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Worker sync');
};
async function client() {
  const store = createMergeableStore();
  const socket = new WebSocket(base.replace(/^http/, 'ws') + '/api/task-sync', { headers });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const sync = await createWsSynchronizer(store, socket as unknown as globalThis.WebSocket);
  await sync.startSync();
  return { store, close: () => sync.destroy() };
}
const projectId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const terminalId = '33333333-3333-4333-8333-333333333333';
const recurringId = '44444444-4444-4444-8444-444444444444';
const conditionId = '55555555-5555-4555-8555-555555555555';
const afterId = '66666666-6666-4666-8666-666666666666';
const recoveryId = '77777777-7777-4777-8777-777777777777';
if (phase === 'seed') {
  assert.equal((await req('/api/projects', 'POST', { id: projectId, title: 'Survives restart' })).status, 201);
  assert.equal((await req('/api/projects', 'POST', { id: targetId, title: 'After target' })).status, 201);
  assert.equal((await req('/api/tasks', 'POST', { id: terminalId, text: 'Completed record', projectId })).status, 201);
  assert.equal((await req(`/api/tasks/${terminalId}/complete`, 'POST')).status, 200);
  assert.equal((await req('/api/tasks', 'POST', {
    id: recurringId, text: 'Repeating record', projectId,
    recurrence: { version: 1, origin: '2026-10-01', anchor: 'scheduled', weekStartsOn: 'MO',
      pattern: { unit: 'month', interval: 1, on: [{ kind: 'day', day: 1 }] } },
  })).status, 201);
  assert.equal((await req(`/api/tasks/${recurringId}/complete-occurrence`, 'POST', {
    scheduledOn: '2026-10-01', completedOn: '2026-10-02',
  })).data.task.recurrenceDate, '2026-11-01');
  assert.equal((await req('/api/waits', 'POST', {
    id: conditionId, projectId, kind: 'free-text', text: 'Resolved record',
  })).status, 201);
  assert.equal((await req(`/api/waits/${conditionId}/resolve`, 'POST')).status, 200);
  assert.equal((await req('/api/waits', 'POST', {
    id: afterId, projectId, kind: 'project-status', refId: targetId, targetStatus: 'done',
  })).status, 201);
  const peer = await client();
  try {
    peer.store.setRow('tasks', recoveryId, {
      text: 'Keep conflicted work', createdAt: new Date().toISOString(), projectId: 'missing',
    });
    await until(async () => (await req('/api/task-recoveries')).data.tasks.some((entry: any) => entry.taskId === recoveryId));
  } finally { await peer.close(); }
  console.log(`PASS seed: ${user}; stop and restart the Worker without clearing --persist-to`);
} else {
  const projects = (await req('/api/projects')).data.projects;
  assert.deepEqual(projects.map((project: any) => project.id), [projectId, targetId]);
  const tasks = (await req('/api/tasks')).data.tasks;
  assert.equal(tasks.find((task: any) => task.id === recurringId)?.recurrenceDate, '2026-11-01');
  assert.equal(tasks.some((task: any) => task.id === terminalId), false);
  assert.equal(tasks.find((task: any) => task.id === recoveryId)?.projectId, null);
  assert.equal((await req('/api/task-recoveries')).data.tasks.some((entry: any) => entry.taskId === recoveryId), true);
  assert.deepEqual((await req('/api/waits')).data.conditions.map((condition: any) => condition.id), [afterId]);
  const fresh = await client();
  try {
    await until(() => fresh.store.getCell('tasks', terminalId, 'completedAt') !== undefined);
    assert.equal(fresh.store.getCell('tasks', recurringId, 'recurrenceDate'), '2026-11-01');
    assert.equal(fresh.store.getCell('conditions', conditionId, 'resolvedAt') !== undefined, true);
    assert.equal(fresh.store.getCell('tasks', recoveryId, 'projectId'), 'missing');
    assert.equal((await req(`/api/projects/${targetId}`, 'PATCH', { state: 'done' })).status, 200);
    await until(() => fresh.store.getCell('conditions', afterId, 'resolvedAt') !== undefined);
  } finally { await fresh.close(); }
  assert.equal((await req('/api/user-data', 'DELETE')).status, 200);
  console.log('PASS verify: Worker restart retained open, terminal, recurring, resolved, and recoverable rows; fresh sync and writes work');
}
