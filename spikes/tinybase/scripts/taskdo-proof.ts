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
  return { status: res.status, data: await res.json() as Record<string, any> };
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
  assert.equal((await req(user, '/api/tasks', 'POST', { id: crypto.randomUUID(), text: 'invalid', projectId: crypto.randomUUID() })).status, 400);
  assert.deepEqual((await req(user, '/api/projects')).data.projects, []);
  assert.equal((await req(user, '/api/projects', 'POST', { id: crypto.randomUUID(), title: 'unsupported' })).status, 409);
  assert.equal((await req(user, `/api/tasks/${id}/complete`, 'POST')).status, 409);
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
  console.log('PASS: TaskDO REST, TinyBase WebSocket sync, SQLite restart, account isolation, fixture gates, and deletion lock');
} finally {
  await a?.close(); await b?.close(); await isolated?.close();
  rmSync(tmp, { recursive: true, force: true });
}
