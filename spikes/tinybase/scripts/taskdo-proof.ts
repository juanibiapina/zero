import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMergeableStore } from 'tinybase';
import { createSqliteNodePersister } from 'tinybase/persisters/persister-sqlite-node';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import WebSocket from 'ws';

const base = process.env.TASKDO_PROOF_ORIGIN ?? 'http://127.0.0.1:8787';
const user = `taskdo-proof-${crypto.randomUUID()}`;
const other = `taskdo-proof-${crypto.randomUUID()}`;
const id = crypto.randomUUID();
const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
};
const req = async (account: string, path: string, method = 'GET', body?: object) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${account}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: res.status === 204 ? {} : await res.json() as Record<string, any> };
};
async function device(account: string, file: string) {
  const db = new DatabaseSync(file);
  const store = createMergeableStore();
  const persister = createSqliteNodePersister(store, db, 'taskdo_local');
  await persister.startAutoPersisting();
  let sync: Awaited<ReturnType<typeof createWsSynchronizer>> | undefined;
  return {
    store,
    async connect() {
      const socket = new WebSocket(base.replace(/^http/, 'ws') + '/api/task-sync', {
        headers: { Authorization: `Bearer ${account}` },
      });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      sync = await createWsSynchronizer(store, socket as unknown as globalThis.WebSocket);
      await sync.startSync();
    },
    async close() {
      await sync?.destroy();
      await persister.destroy();
      db.close();
    },
  };
}
const tmp = mkdtempSync(join(tmpdir(), 'taskdo-vertical-'));
let a: Awaited<ReturnType<typeof device>> | undefined;
let b: Awaited<ReturnType<typeof device>> | undefined;
let isolated: Awaited<ReturnType<typeof device>> | undefined;
try {
  a = await device(user, join(tmp, 'a.db'));
  b = await device(user, join(tmp, 'b.db'));
  isolated = await device(other, join(tmp, 'other.db'));
  await Promise.all([a.connect(), b.connect(), isolated.connect()]);
  assert.equal((await req(user, '/api/tasks')).status, 200);
  a.store.setRow('tasks', id, { text: 'created offline', createdAt: new Date().toISOString() });
  await a.close(); a = undefined;
  a = await device(user, join(tmp, 'a.db'));
  assert.equal(a.store.getCell('tasks', id, 'text'), 'created offline', 'SQLite restored unsent Task');
  await a.connect();
  await until(async () => (await req(user, '/api/tasks')).data.tasks?.some((t: any) => t.id === id), 'mobile -> REST');
  await until(() => b!.store.getCell('tasks', id, 'text') === 'created offline', 'mobile -> second client');
  assert.deepEqual((await req(other, '/api/tasks')).data.tasks, []);
  assert.equal(isolated.store.getCell('tasks', id, 'text'), undefined);
  const edited = await req(user, `/api/tasks/${id}`, 'PATCH', { text: 'from REST' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  await until(() => a!.store.getCell('tasks', id, 'text') === 'from REST', 'REST -> mobile');
  await until(() => b!.store.getCell('tasks', id, 'text') === 'from REST', 'REST -> second client');
  const retryId = crypto.randomUUID();
  const first = await req(user, '/api/tasks', 'POST', { id: retryId, text: 'idempotent REST' });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const retry = await req(user, '/api/tasks', 'POST', { id: retryId, text: 'idempotent REST' });
  assert.equal(retry.data.task.id, first.data.task.id);
  await until(() => b!.store.getCell('tasks', retryId, 'text') === 'idempotent REST', 'REST -> second client');
  assert.equal((await req(user, '/api/tasks', 'POST', { id: crypto.randomUUID(), text: 'invalid', projectId: crypto.randomUUID() })).status, 409);
  assert.deepEqual((await req(user, '/api/projects')).data.projects, []);
  const projectId = crypto.randomUUID();
  const createdProject = await req(user, '/api/projects', 'POST', { id: projectId, title: 'Proof Project' });
  assert.equal(createdProject.status, 201, JSON.stringify(createdProject.data));
  const linkedId = crypto.randomUUID();
  const linked = await req(user, '/api/tasks', 'POST', { id: linkedId, text: 'Project Task', projectId });
  assert.equal(linked.status, 201, JSON.stringify(linked.data));
  await until(() => b!.store.getCell('tasks', linkedId, 'projectId') === projectId, 'linked Task sync');
  const targetId = crypto.randomUUID();
  assert.equal((await req(user, '/api/projects', 'POST', { id: targetId, title: 'Target Project' })).status, 201);
  const waitingId = crypto.randomUUID();
  assert.equal((await req(user, '/api/waits', 'POST', {
    id: waitingId, projectId, kind: 'free-text', text: 'Wait for answer',
  })).status, 201);
  assert.equal((await req(user, `/api/waits/${waitingId}/resolve`, 'POST')).data.condition.resolvedAt !== null, true);
  assert.equal((await req(user, '/api/waits')).data.conditions.some((condition: any) => condition.id === waitingId), false);
  const afterId = '11111111-1111-4111-8111-111111111111';
  const cycleId = '22222222-2222-4222-8222-222222222222';
  assert.equal((await req(user, '/api/waits', 'POST', {
    id: afterId, projectId, kind: 'project-status', refId: targetId, targetStatus: 'done',
  })).status, 201);
  await until(() => b!.store.getCell('conditions', afterId, 'refId') === targetId, 'After sync');
  assert.equal((await req(user, '/api/waits', 'POST', {
    id: cycleId, projectId: targetId, kind: 'project-status', refId: projectId, targetStatus: 'done',
  })).status, 409);
  b.store.setRow('conditions', cycleId, {
    projectId: targetId, kind: 'project-status', refId: projectId,
    targetStatus: 'done', createdAt: new Date().toISOString(),
  });
  await until(async () => (await req(user, '/api/task-recoveries')).data.conditions?.some(
    (condition: any) => condition.conditionId === cycleId && condition.reason === 'cycle'), 'raw cycle recovery');
  assert.equal((await req(user, '/api/waits')).data.conditions.some((condition: any) => condition.id === cycleId), false);
  assert.equal((await req(user, `/api/projects/${targetId}`, 'PATCH', { state: 'done' })).status, 200);
  await until(() => b!.store.getCell('conditions', afterId, 'resolvedAt') !== undefined, 'Done settles After');
  assert.equal((await req(user, '/api/waits')).data.conditions.some((condition: any) => condition.id === afterId), false);
  assert.equal((await req(user, `/api/projects/${targetId}`, 'PATCH', { state: 'in-play' })).status, 200);
  await until(() => b!.store.getCell('conditions', afterId, 'resolvedAt') === undefined, 'reopen restores After');
  assert.equal((await req(user, '/api/waits')).data.conditions.some((condition: any) => condition.id === afterId), true);
  assert.equal((await req(user, `/api/tasks/${id}/complete`, 'POST')).status, 409);
  await a.close(); a = undefined;
  a = await device(user, join(tmp, 'a.db'));
  assert.equal(a.store.getCell('projects', projectId, 'title'), 'Proof Project');
  assert.equal((await req(user, `/api/projects/${projectId}`, 'DELETE')).status, 204);
  await until(() => !b!.store.hasRow('tasks', linkedId), 'Project delete cascades linked Task');
  const lateId = crypto.randomUUID();
  a.store.setRow('tasks', lateId, { text: 'offline after deletion', createdAt: new Date().toISOString(), projectId });
  const lateConditionId = crypto.randomUUID();
  a.store.setRow('conditions', lateConditionId, {
    projectId, kind: 'free-text', text: 'offline waiting', createdAt: new Date().toISOString(),
  });
  await a.connect();
  await until(async () => (await req(user, '/api/task-recoveries')).data.tasks?.some((item: any) => item.taskId === lateId), 'late Task recovery');
  await until(async () => (await req(user, '/api/task-recoveries')).data.conditions?.some(
    (item: any) => item.conditionId === lateConditionId), 'late Waiting recovery');
  const missingId = crypto.randomUUID();
  const missingProjectId = crypto.randomUUID();
  b.store.setRow('tasks', missingId, {
    text: 'recover malformed link', createdAt: new Date().toISOString(), projectId: missingProjectId,
  });
  await until(async () => (await req(user, '/api/task-recoveries')).data.tasks?.length === 2, 'missing Project recovery');
  const recoveries = await req(user, '/api/task-recoveries');
  assert.deepEqual(recoveries.data.tasks.sort((x: any, y: any) => x.taskId.localeCompare(y.taskId)), [
    { taskId: lateId, projectId, reason: 'deleted-project' },
    { taskId: missingId, projectId: missingProjectId, reason: 'missing-project' },
  ].sort((x, y) => x.taskId.localeCompare(y.taskId)));
  assert.equal((await req(user, '/api/tasks')).data.tasks?.find((task: any) => task.id === lateId)?.projectId, null);
  assert.equal((await req(user, '/api/tasks')).data.tasks?.find((task: any) => task.id === missingId)?.projectId, null);
  assert.deepEqual(recoveries.data.conditions, [{
    conditionId: lateConditionId, projectId, refId: null, reason: 'missing-source',
  }]);
  assert.equal(a.store.getCell('conditions', lateConditionId, 'text'), 'offline waiting');
  assert.equal(a.store.getCell('tasks', lateId, 'projectId'), projectId, 'offline intent retained');
  assert.equal((await req(user, `/api/projects/${projectId}`, 'DELETE')).status, 204);
  assert.equal((await req(user, '/api/tasks')).data.tasks?.some((task: any) => task.id === lateId), true,
    'retrying Project delete cannot erase the recovered late Task');
  assert.equal((await fetch(`${base}/api/task-sync`, { headers: { Authorization: 'Bearer e2e-test-user' } })).status, 404);
  await a.close(); a = undefined;
  const erased = await req(user, '/api/user-data', 'DELETE');
  assert.equal(erased.status, 200, JSON.stringify(erased.data));
  await b.close(); b = undefined;
  assert.deepEqual((await req(user, '/api/tasks')).data.tasks, [], 'deleted Tasks must not return');
  const stale = await device(user, join(tmp, 'b.db'));
  try {
    assert.equal(stale.store.getCell('tasks', id, 'text'), 'from REST');
    await assert.rejects(stale.connect(), /410/);
  } finally { await stale.close(); }
  assert.deepEqual((await req(user, '/api/tasks')).data.tasks, [], 'reconnecting stale client cannot restore Tasks');
  console.log('PASS: TaskDO REST/WebSocket sync, Waiting/After cycle and Done/reopen, late-child recovery, SQLite client restart, isolation, erasure');
} finally {
  await a?.close(); await b?.close(); await isolated?.close();
  rmSync(tmp, { recursive: true, force: true });
}
