import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMergeableStore, createMiddleware } from 'tinybase';
import { createFilePersister } from 'tinybase/persisters/persister-file';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { createWsServer } from 'tinybase/synchronizers/synchronizer-ws-server';
import { WebSocket, WebSocketServer } from 'ws';

async function waitFor(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'tinybase-middleware-'));
  const ws = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => ws.once('listening', resolve));
  const port = (ws.address() as { port: number }).port;
  let serverStore: ReturnType<typeof createMergeableStore> | undefined;
  const errors: string[] = [];
  const server = createWsServer(
    ws,
    () => {
      serverStore = createMergeableStore();
      createMiddleware(serverStore).addWillApplyChangesCallback((changes) => {
        const incoming = changes[0]?.tasks ?? {};
        if (Object.values(incoming).some((row) => row?.projectId === 'missing')) {
          return undefined;
        }
        return changes;
      });
      return createFilePersister(serverStore, join(dir, 'account.json'));
    },
    (error) => errors.push(String(error)),
  );
  const clients: Array<Awaited<ReturnType<typeof createWsSynchronizer>>> = [];
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const store = createMergeableStore();
    const socket = new WebSocket(`ws://localhost:${port}/account`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const sync = await createWsSynchronizer(store, socket as unknown as globalThis.WebSocket);
    clients.push(sync);
    await sync.startSync();
    return store;
  };
  try {
    const a = await connect();
    const b = await connect();
    await waitFor(() => serverStore != null, 'server ready');
    const before = serverStore!.getMergeableContentHashes();
    a.setRow('tasks', 'bad', { text: 'save me', projectId: 'missing' });
    await waitFor(() => b.hasRow('tasks', 'bad'), 'second client receives invalid Task');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(serverStore!.hasRow('tasks', 'bad'), false);
    const rejectedHash = serverStore!.getMergeableContentHashes();
    assert.notDeepEqual(rejectedHash, before,
      'returning undefined prevents the visible row but still changes merge metadata');
    assert.equal(b.getCell('tasks', 'bad', 'projectId'), 'missing');
    const third = await connect();
    await waitFor(() => third.hasRow('tasks', 'bad'), 'third client receives invalid Task from connected peers');
    await Promise.all(clients.splice(0).map((sync) => sync.destroy()));
    sockets.splice(0).forEach((socket) => socket.terminate());
    await new Promise((resolve) => setTimeout(resolve, 200));
    const fourth = await connect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fourth.hasRow('tasks', 'bad'), false,
      'without a peer holding the invalid row, a later client did not receive it');
    console.log(JSON.stringify({
      serverHashesBefore: before,
      rejectedHash,
      secondClientRow: b.getRow('tasks', 'bad'),
      thirdClientRow: third.getRow('tasks', 'bad'),
      fourthClientRow: fourth.getRow('tasks', 'bad'),
      restartedServerHash: serverStore!.getMergeableContentHashes(),
      errors,
    }));
  } finally {
    await Promise.all(clients.map((sync) => sync.destroy().catch(() => {})));
    sockets.forEach((socket) => socket.terminate());
    await server.destroy();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

await run();

const server = createMergeableStore();
const client = createMergeableStore();
createMiddleware(server).addWillApplyChangesCallback(() => {
  throw new Error('invalid project');
});
client.setRow('tasks', 'bad', { text: 'save me', projectId: 'missing' });
const before = server.getMergeableContentHashes();
assert.throws(() => server.applyMergeableChanges(client.getMergeableContent()), /invalid project/);
assert.deepEqual(server.getMergeableContentHashes(), before,
  'a thrown error rolls back local merge metadata, unlike returning undefined');
console.log('Local thrown merge rolls back metadata; WebSocket relaying must be checked separately.');
