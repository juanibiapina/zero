import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMergeableStore } from 'tinybase';
import { createSqliteNodePersister } from 'tinybase/persisters/persister-sqlite-node';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import WebSocket from 'ws';

const origin = process.env.TASKDO_PROOF_ORIGIN ?? 'http://127.0.0.1:8787';
const account = `taskdo-proof-conflict-${crypto.randomUUID()}`;
const headers = { Authorization: `Bearer ${account}`, 'Content-Type': 'application/json' };
const taskId = crypto.randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'taskdo-conflict-'));
const until = async (predicate: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for revision sync');
};
async function device(path: string) {
  const db = new DatabaseSync(path);
  const store = createMergeableStore();
  const persister = createSqliteNodePersister(store, db, 'replica');
  await persister.startAutoPersisting();
  let sync: Awaited<ReturnType<typeof createWsSynchronizer>> | undefined;
  return {
    store,
    async connect() {
      const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/task-sync', { headers });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      sync = await createWsSynchronizer(store, socket as unknown as globalThis.WebSocket);
      await sync.startSync();
    },
    async close() { await sync?.destroy(); await persister.destroy(); db.close(); },
  };
}
const aPath = join(dir, 'a.db');
const bPath = join(dir, 'b.db');
let a: Awaited<ReturnType<typeof device>> | undefined;
let b: Awaited<ReturnType<typeof device>> | undefined;
try {
  a = await device(aPath);
  b = await device(bPath);
  await Promise.all([a.connect(), b.connect()]);
  const created = await fetch(origin + '/api/tasks', {
    method: 'POST', headers, body: JSON.stringify({ id: taskId, text: 'Original' }),
  });
  assert.equal(created.status, 201);
  await until(() => a!.store.hasRow('tasks', taskId) && b!.store.hasRow('tasks', taskId));
  await a.close(); a = undefined;
  await b.close(); b = undefined;
  a = await device(aPath);
  b = await device(bPath);
  a.store.setRow('task-edits', '11111111-1111-4111-8111-111111111111', {
    taskId, baseRevision: 'original', text: 'Offline A',
  });
  b.store.setRow('task-edits', '22222222-2222-4222-8222-222222222222', {
    taskId, baseRevision: 'original', text: 'Offline B',
  });
  await Promise.all([a.connect(), b.connect()]);
  const read = () => fetch(origin + '/api/task-recoveries', { headers }).then((response) => response.json() as Promise<any>);
  await until(async () => (await read()).tasks.some((item: any) => item.text === 'Offline A'));
  const conflicts = await read();
  assert.deepEqual(conflicts.tasks.filter((item: any) => item.taskId === taskId).map((item: any) => item.text), ['Offline A']);
  const tasks = await fetch(origin + '/api/tasks', { headers }).then((response) => response.json() as Promise<any>);
  assert.equal(tasks.tasks.find((task: any) => task.id === taskId)?.text, 'Offline B');
  for (const peer of [a, b]) {
    await until(() => Object.keys(peer!.store.getTable('task-edits')).length === 2);
    assert.deepEqual(Object.values(peer!.store.getTable('task-edits')).map((row) => row.text).sort(),
      ['Offline A', 'Offline B']);
  }
  console.log('PASS: concurrent offline text edits survive SQLite restart, Worker sync, REST projection and recovery');
} finally {
  await a?.close(); await b?.close();
  rmSync(dir, { recursive: true, force: true });
}
