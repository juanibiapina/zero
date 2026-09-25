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
  assert.equal((await req(user, `/api/tasks/${id}/complete`, 'POST')).status, 409);
  await a.close(); a = undefined;
  a = await device(user, join(tmp, 'a.db'));
  assert.equal(a.store.getCell('projects', projectId, 'title'), 'Proof Project');
  assert.equal((await req(user, `/api/projects/${projectId}`, 'DELETE')).status, 204);
  await until(() => !b!.store.hasRow('tasks', linkedId), 'Project delete cascades linked Task');
  const lateId = crypto.randomUUID();
  a.store.setRow('tasks', lateId, { text: 'offline after deletion', createdAt: new Date().toISOString(), projectId });
  await a.connect();
  await until(async () => (await req(user, '/api/task-recoveries')).data.tasks?.some((item: any) => item.taskId === lateId), 'late Task recovery');
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
  console.log('PASS: TaskDO REST, WebSocket sync, Project tombstone/late-child recovery, SQLite restart, account isolation, and deletion lock');
} finally {
  await a?.close(); await b?.close(); await isolated?.close();
  rmSync(tmp, { recursive: true, force: true });
}
