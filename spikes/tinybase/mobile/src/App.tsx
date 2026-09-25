import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, Text } from 'react-native';
import { openDatabaseAsync } from 'expo-sqlite';
import { createMergeableStore } from 'tinybase';
import { createExpoSqlitePersister } from 'tinybase/persisters/persister-expo-sqlite';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';

const proofId = process.env.EXPO_PUBLIC_PROOF_ID ?? 'standalone';
const projectId = `server-${proofId}`;
const taskId = `mobile-${proofId}`;

export default function App() {
  const [status, setStatus] = useState('OPENING');
  const [editOffline, setEditOffline] = useState<() => void>(() => () => {});
  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    void (async () => {
      const store = createMergeableStore();
      const db = await openDatabaseAsync('tinybase-proof.sqlite');
      const persister = createExpoSqlitePersister(store, db, 'tinybase_proof');
      cleanup = () => { void persister.destroy(); };
      try {
        await persister.startAutoPersisting();
        const marker = store.getCell('proofs', proofId, 'saved') === 'yes';
        const taskText = store.getCell('tasks', taskId, 'text');
        const restored = marker && (taskText === 'created on Android' || taskText === 'edited offline');
        if (marker && !restored) throw new Error('Task lost on restart');
        if (!restored) {
          store.setCell('proofs', proofId, 'saved', 'yes');
          store.setRow('tasks', taskId, { text: 'created on Android', projectId, completed: false });
          await persister.save();
        }
        if (!cancelled) {
          setStatus(taskText === 'edited offline' ? 'RESTORED OFFLINE EDIT' : restored ? 'RESTORED FROM SQLITE' : 'SAVED TO SQLITE');
          setEditOffline(() => () => {
            store.setCell('tasks', taskId, 'text', 'edited offline');
            void persister.save().then(() => setStatus('OFFLINE EDIT SAVED'));
          });
        }

        // React Native supports custom headers in the third WebSocket argument.
        // The fixed token is only accepted by the local proof Worker.
        const socket = new (WebSocket as unknown as new (
          url: string, protocols: string[], options: { headers: Record<string, string> },
        ) => WebSocket)('ws://localhost:8787/sync', [], {
          headers: { Authorization: 'Bearer proof-user-a' },
        });
        cleanup = () => { socket.close(); void persister.destroy(); };
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => resolve(), { once: true });
          socket.addEventListener('error', () => reject(new Error('WebSocket unavailable')), { once: true });
        });
        const sync = await createWsSynchronizer(store, socket);
        cleanup = () => { void sync.destroy(); void persister.destroy(); };
        await sync.startSync();
        const observeProject = () => {
          if (store.getCell('projects', projectId, 'title') === 'From REST' && !cancelled) {
            setStatus(restored ? 'RESTORED AND SYNCED' : 'SAVED AND SYNCED');
          }
        };
        store.addCellListener('projects', projectId, 'title', observeProject);
        observeProject();
      } catch (error) {
        // Offline operation remains usable; the SQLite result stays visible.
        if (!cancelled) setStatus((current) => `${current} (OFFLINE: ${String(error)})`);
      }
    })();
    return () => { cancelled = true; cleanup(); };
  }, []);
  return <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
    <Text style={{ fontSize: 24, textAlign: 'center' }}>{status}</Text>
    <Pressable accessibilityLabel="Edit offline" onPress={editOffline} style={{ marginTop: 32, padding: 20 }}>
      <Text style={{ fontSize: 20 }}>EDIT OFFLINE</Text>
    </Pressable>
  </SafeAreaView>;
}
