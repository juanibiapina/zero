import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMergeableStore, type MergeableStore } from 'tinybase';
import { createSqliteNodePersister } from 'tinybase/persisters/persister-sqlite-node';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import WebSocket from 'ws';

const origin = 'http://127.0.0.1:8787';
const token = (account: 'a' | 'b') => `Bearer proof-user-${account}`;
const request = async (account: 'a' | 'b', path: string, body?: unknown) => {
  const response = await fetch(`${origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: token(account), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status !== 200) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ projects: Record<string, { title: string }>; tasks: Record<string, { text: string; projectId: string; completed: boolean }> }>;
};
const until = async (predicate: () => boolean | Promise<boolean>, description: string) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
};

async function device(path: string) {
  const database = new DatabaseSync(path);
  const store = createMergeableStore();
  const persister = createSqliteNodePersister(store, database, 'proof_local');
  await persister.startAutoPersisting();
  let synchronizer: Awaited<ReturnType<typeof createWsSynchronizer>> | undefined;
  return {
    store,
    async connect(account: 'a' | 'b') {
      const socket = new WebSocket('ws://127.0.0.1:8787/sync', {
        headers: { authorization: token(account) },
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      synchronizer = await createWsSynchronizer(store, socket as unknown as globalThis.WebSocket);
      await synchronizer.startSync();
    },
    async disconnect() {
      if (synchronizer) await synchronizer.destroy();
      synchronizer = undefined;
    },
    async close() {
      await this.disconnect();
      await persister.destroy();
      database.close();
    },
  };
}

const workdir = mkdtempSync(join(tmpdir(), 'tinybase-proof-'));
const projectId = `p-${crypto.randomUUID()}`;
const taskId = `t-${crypto.randomUUID()}`;
let first: Awaited<ReturnType<typeof device>> | undefined;
let second: Awaited<ReturnType<typeof device>> | undefined;
let otherAccount: Awaited<ReturnType<typeof device>> | undefined;
try {
  first = await device(join(workdir, 'device-a.sqlite'));
  second = await device(join(workdir, 'device-b.sqlite'));
  otherAccount = await device(join(workdir, 'device-other-account.sqlite'));
  await first.connect('a');
  await second.connect('a');
  await otherAccount.connect('b');

  // This REST write uses the exact same DO MergeableStore as both sockets.
  await request('a', '/api/projects', { id: projectId, title: 'REST project' });
  await until(() => first!.store.getCell('projects', projectId, 'title') === 'REST project', 'REST -> device A');
  await until(() => second!.store.getCell('projects', projectId, 'title') === 'REST project', 'REST -> device B');
  first.store.setRow('tasks', taskId, { text: 'offline-safe task', projectId, completed: false });
  await until(async () => (await request('a', '/api/state')).tasks[taskId]?.text === 'offline-safe task', 'device -> server');
  await until(() => second!.store.getCell('tasks', taskId, 'text') === 'offline-safe task', 'device A -> device B');
  assert.equal((await request('b', '/api/state')).tasks[taskId], undefined, 'account B REST cannot see account A');
  assert.equal(otherAccount.store.getCell('tasks', taskId, 'text'), undefined, 'account B WebSocket cannot see account A');
  const unauthorized = await fetch(`${origin}/api/state`);
  assert.equal(unauthorized.status, 401);

  await first.disconnect();
  await first.close();
  first = await device(join(workdir, 'device-a.sqlite'));
  assert.equal(first.store.getCell('tasks', taskId, 'text'), 'offline-safe task', 'disk survives reopen');
  first.store.setCell('tasks', taskId, 'text', 'edited while disconnected');
  await first.close();
  first = await device(join(workdir, 'device-a.sqlite'));
  assert.equal(first.store.getCell('tasks', taskId, 'text'), 'edited while disconnected', 'offline edit survives reopen');
  await first.connect('a');
  await until(async () => (await request('a', '/api/state')).tasks[taskId]?.text === 'edited while disconnected', 'offline edit -> server');
  await until(() => second!.store.getCell('tasks', taskId, 'text') === 'edited while disconnected', 'offline edit -> second device');

  const rejected = await fetch(`${origin}/api/tasks`, {
    method: 'POST',
    headers: { authorization: token('a'), 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'rest-orphan', text: 'orphan', projectId: 'missing', completed: false }),
  });
  assert.equal(rejected.status, 409, 'REST rejects an unknown Project');
  const orphanId = `orphan-${crypto.randomUUID()}`;
  first.store.setRow('tasks', orphanId, { text: 'direct sync bypasses REST', projectId: 'missing', completed: false });
  await until(async () => !!(await request('a', '/api/state')).tasks[orphanId], 'direct sync of invalid reference');
  await until(() => second!.store.getCell('tasks', orphanId, 'projectId') === 'missing', 'orphan -> second device');
  console.log('GAP: WebSocket sync accepted a Task with a nonexistent Project; REST-only validation is insufficient.');

  if (process.env.PROOF_RESULT_PATH) {
    writeFileSync(process.env.PROOF_RESULT_PATH, JSON.stringify({ projectId, taskId }));
  }
  console.log(`PASS: REST and two devices converge; offline SQLite reopen syncs; account B isolated (project ${projectId}, task ${taskId}).`);
} finally {
  await first?.close();
  await second?.close();
  await otherAccount?.close();
  rmSync(workdir, { recursive: true, force: true });
}
