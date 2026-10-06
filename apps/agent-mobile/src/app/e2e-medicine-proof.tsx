import { QueryClient } from '@tanstack/react-query';
import { createMedicineReminders, medicineOccurrences, medicineToday, type TaskdoReplica } from '@zero/agent-core';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { RUNTIME_PROFILE } from '@/lib/runtime-profile';
import { openTaskDOReplica } from '@/lib/taskdo-replica';
import { medicineReminderDevice as device, medicineReminderProof as proof, reminderSettings as settings } from '../../modules/medicine-reminders';

const workspace = 'taskdo-workspace-medicine-proof.sqlite';
export default function MedicineProof() {
  const [replica, setReplica] = useState<TaskdoReplica | null>(null);
  const [status, setStatus] = useState('Opening medicine proof');
  useEffect(() => {
    if (!RUNTIME_PROFILE.hermetic) return;
    let disposed = false; let opened: TaskdoReplica | undefined;
    void openTaskDOReplica({ descriptor: { version: 1, databaseName: workspace, binding: { kind: 'unbound' } }, getToken: async () => null, queryClient: new QueryClient(), onSnapshot: () => {}, onConnection: () => {} }).then(async (value) => {
      opened = value;
      if (disposed) await value.close();
      else { setReplica(value); setStatus('Medicine native proof'); }
    }).catch((error: unknown) => setStatus(String(error)));
    return () => { disposed = true; void opened?.close(); };
  }, []);
  if (!RUNTIME_PROFILE.hermetic) return <Redirect href="/" />;
  const run = async (action: () => Promise<void>) => { try { await action(); } catch (error) { setStatus(String(error)); } };
  const schedule = (delay = 125_000, earlyOffset = 240_000, multiple = false) => run(async () => {
    if (!device || !proof || !replica) throw new Error('Native reminder module or workspace missing');
    await proof.silenceProof();
    const alarm = new Date(Date.now() + delay); alarm.setSeconds(0, 0);
    const early = new Date(alarm.getTime() - earlyOffset);
    if (early.getDate() !== alarm.getDate() || alarm.getDate() !== new Date().getDate()) throw new Error('Run the proof away from midnight');
    const hhmm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    await device.clear(workspace);
    for (const item of replica.snapshot().medicines) await replica.medicines.remove(item.id);
    const medicine = await replica.medicines.add({ name: 'E2E medicine', instructions: 'Native proof only', startsOn: medicineToday(), endsOn: medicineToday(), paused: false, doses: [{ id: 'evening', remindAt: hhmm(early), alarmAt: hhmm(alarm) }] });
    const peer = multiple ? await replica.medicines.add({ ...medicine, name: 'E2E second medicine' }) : null;
    await device.replace(workspace, { medicines: peer ? [medicine, peer] : [medicine], confirmed: [] });
    setStatus(`Notifications scheduled ${hhmm(alarm)}`);
  });
  const clear = () => run(async () => { await device?.clear(workspace); setStatus('Medicine proof cleared'); });
  const take = () => run(async () => {
    const medicine = replica!.snapshot().medicines[0];
    await device!.take(workspace, medicineOccurrences(medicine, medicineToday())[0]);
    setStatus('Dose taken natively');
  });
  const importReceipts = () => run(async () => {
    if (!replica || !device) throw new Error('Proof not ready');
    const controller = createMedicineReminders(replica, device, workspace);
    try { await controller.enable(); } finally { await controller.close(); }
    const doses = replica.snapshot().doses;
    const taken = doses.filter((dose) => dose.takenAt);
    setStatus(`Persisted taken doses: ${taken.length}${taken[0]?.takenAt ? ` at ${taken[0].takenAt}` : ''}`);
  });
  const replayUndo = () => run(async () => {
    if (!replica || !device) throw new Error('Proof not ready');
    const dose = medicineOccurrences(replica.snapshot().medicines[0], medicineToday())[0];
    await device.take(workspace, dose);
    const captured = await device.receipts(workspace);
    await replica.medicines.applyReceipts(captured, workspace);
    await replica.medicines.undo(dose.id);
    await replica.medicines.applyReceipts(captured, workspace);
    if (replica.snapshot().doses.find((item) => item.id === dose.id)?.takenAt) throw new Error('Replay recreated confirmation');
    const snapshot = replica.snapshot();
    const ids = captured.map((receipt) => receipt.actionId);
    await device.replace(workspace, {
      medicines: snapshot.medicines, confirmed: snapshot.doses.filter((item) => item.takenAt).map((item) => item.id), processedActions: ids,
    });
    await device.acknowledge(workspace, ids);
    setStatus('Undone receipt remains pending');
  });
  const quiescence = () => run(async () => {
    if (!replica || !device) throw new Error('Proof not ready');
    const dose = medicineOccurrences(replica.snapshot().medicines[0], medicineToday())[0];
    const controller = createMedicineReminders(replica, device, workspace);
    try {
      await controller.enable();
      const [, action] = await Promise.allSettled([controller.checkpoint(), device.take(workspace, dose)]);
      await controller.checkpoint();
      if (action.status === 'fulfilled') {
        if (replica.snapshot().doses.find((item) => item.id === dose.id)?.takenAt !== action.value.takenAt) throw new Error('Accepted receipt lost during checkpoint');
      }
      const before = (await device.receipts(workspace)).length;
      let rejected = false;
      try { await device.take(workspace, dose); } catch { rejected = true; }
      if (!rejected || (await device.receipts(workspace)).length !== before) throw new Error('Closed workspace accepted Taken');
      setStatus('Quiescence race safe');
    } finally { await controller.close(); }
  });
  return <View className="flex-1 justify-center gap-4 bg-background px-screen-x">
    <Text>{status}</Text>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule()} className="min-h-12"><Text>Schedule native proof</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule(235_000)} className="min-h-12"><Text>Schedule visible reminder proof</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule(305_000)} className="min-h-12"><Text>Schedule reboot proof</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule(245_000, 120_000)} className="min-h-12"><Text>Schedule both stages proof</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule(125_000, 240_000, true)} className="min-h-12"><Text>Schedule multiple doses proof</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void take()} className="min-h-12"><Text>Take native proof</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void importReceipts()} className="min-h-12"><Text>Import medicine receipts</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void replayUndo()} className="min-h-12"><Text>Check undone receipt replay</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void quiescence()} className="min-h-12"><Text>Check quiescence race</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => settings?.openNotificationSettings()} className="min-h-12"><Text>Open medicine notification settings</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => settings?.openReminderSettings()} className="min-h-12"><Text>Open medicine reminder category</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void clear()} className="min-h-12"><Text>Clear native proof</Text></Pressable>
  </View>;
}
