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
const account = `taskdo-proof-lww-${crypto.randomUUID()}`;
const headers = { Authorization: `Bearer ${account}`, 'Content-Type': 'application/json' };
const taskId = crypto.randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'taskdo-lww-'));
const until = async (predicate: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for sync');
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
  assert.equal((await fetch(origin + '/api/tasks', {
    method: 'POST', headers, body: JSON.stringify({ id: taskId, text: 'Original' }),
  })).status, 201);
  await until(() => a!.store.hasRow('tasks', taskId) && b!.store.hasRow('tasks', taskId));
  await a.close(); a = undefined;
  await b.close(); b = undefined;
  a = await device(aPath);
  b = await device(bPath);
  a.store.setCell('tasks', taskId, 'text', 'Offline A');
  b.store.setCell('tasks', taskId, 'text', 'Offline B');
  await Promise.all([a.connect(), b.connect()]);
  await until(async () => {
    const left = a!.store.getCell('tasks', taskId, 'text');
    const right = b!.store.getCell('tasks', taskId, 'text');
    const rest = await fetch(origin + '/api/tasks', { headers }).then((r) => r.json() as Promise<any>);
    return left === right && rest.tasks[0]?.text === left && left !== 'Original';
  });
  const winner = a.store.getCell('tasks', taskId, 'text');
  assert.ok(winner === 'Offline A' || winner === 'Offline B');
  assert.equal(b.store.getCell('tasks', taskId, 'text'), winner);
  console.log(`PASS: same-cell LWW converged across SQLite clients and REST to ${winner}`);
} finally {
  await a?.close(); await b?.close();
  rmSync(dir, { recursive: true, force: true });
}
