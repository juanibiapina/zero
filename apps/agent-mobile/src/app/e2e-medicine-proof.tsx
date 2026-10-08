import { QueryClient } from '@tanstack/react-query';
import { createMedicineReminders, MEDICINE_CHANNEL, MEDICINE_SOURCE, medicineOccurrence, medicineOccurrences, medicineReceipt, medicineSchedule, medicineToday, type MedicineReceipt, type TaskdoReplica } from '@zero/agent-core';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { RUNTIME_PROFILE } from '@/lib/runtime-profile';
import { openTaskDOReplica } from '@/lib/taskdo-replica';
import { notificationDevice as device, notificationProof as proof, notificationSettings as settings } from '../../modules/zero-notifications';

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
  const schedule = (delay = 190_000, earlyOffset = 120_000, multiple = false) => run(async () => {
    if (!device || !proof || !replica) throw new Error('Native reminder module or workspace missing');
    await proof.silence(workspace);
    const alarm = new Date(Date.now() + delay); alarm.setSeconds(0, 0);
    const early = new Date(alarm.getTime() - earlyOffset);
    if (early.getDate() !== alarm.getDate() || alarm.getDate() !== new Date().getDate()) throw new Error('Run the proof away from midnight');
    const hhmm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    await device.clear(workspace);
    for (const item of replica.snapshot().medicines) await replica.medicines.remove(item.id);
    const medicine = await replica.medicines.add({ name: 'E2E medicine', instructions: 'Native proof only', startsOn: medicineToday(), endsOn: medicineToday(), paused: false, weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [{ id: 'evening', remindAt: hhmm(early), alarmAt: hhmm(alarm), amount: 1 }] });
    const peer = multiple ? await replica.medicines.add({ ...medicine, name: 'E2E second medicine' }) : null;
    await device.install(workspace, MEDICINE_SOURCE, medicineSchedule({ medicines: peer ? [medicine, peer] : [medicine], doses: [] }));
    setStatus(`Notifications scheduled ${hhmm(alarm)}`);
  });
  const clear = () => run(async () => { await device?.clear(workspace); setStatus('Medicine proof cleared'); });
  const take = () => run(async () => {
    const medicine = replica!.snapshot().medicines[0];
    const { key, date } = medicineOccurrence(medicineOccurrences(medicine, medicineToday())[0]);
    await device!.settle(workspace, MEDICINE_SOURCE, key, date, 'taken');
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
    const { key, date } = medicineOccurrence(dose);
    await device.settle(workspace, MEDICINE_SOURCE, key, date, 'taken');
    const captured = await device.receipts(workspace, MEDICINE_SOURCE);
    const doses = captured.map(medicineReceipt).filter((receipt): receipt is MedicineReceipt => receipt !== null);
    await replica.medicines.applyReceipts(doses, workspace);
    await replica.medicines.undo(dose.id);
    await replica.medicines.applyReceipts(doses, workspace);
    if (replica.snapshot().doses.find((item) => item.id === dose.id)?.takenAt) throw new Error('Replay recreated confirmation');
    await device.acknowledge(workspace, MEDICINE_SOURCE, captured.map((receipt) => receipt.id));
    await device.install(workspace, MEDICINE_SOURCE, medicineSchedule(replica.snapshot()));
    setStatus('Undone receipt remains pending');
  });
  const quiescence = () => run(async () => {
    if (!replica || !device) throw new Error('Proof not ready');
    const dose = medicineOccurrences(replica.snapshot().medicines[0], medicineToday())[0];
    const controller = createMedicineReminders(replica, device, workspace);
    try {
      await controller.enable();
      const { key, date } = medicineOccurrence(dose);
      const [, action] = await Promise.allSettled([controller.checkpoint(), device.settle(workspace, MEDICINE_SOURCE, key, date, 'taken')]);
      await controller.checkpoint();
      if (action.status === 'fulfilled') {
        if (replica.snapshot().doses.find((item) => item.id === dose.id)?.takenAt !== action.value.at) throw new Error('Accepted receipt lost during checkpoint');
      }
      const before = (await device.receipts(workspace, MEDICINE_SOURCE)).length;
      let rejected = false;
      try { await device.settle(workspace, MEDICINE_SOURCE, key, date, 'taken'); } catch { rejected = true; }
      if (!rejected || (await device.receipts(workspace, MEDICINE_SOURCE)).length !== before) throw new Error('Closed workspace accepted Taken');
      setStatus('Quiescence race safe');
    } finally { await controller.close(); }
  });
  return <View className="flex-1 justify-center gap-4 bg-background px-screen-x">
    <Text>{status}</Text>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule()} className="min-h-12"><Text>Schedule native proof</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule(130_000, 60_000)} className="min-h-12"><Text>Schedule visible reminder proof</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule(305_000)} className="min-h-12"><Text>Schedule reboot proof</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule(245_000, 120_000)} className="min-h-12"><Text>Schedule both stages proof</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!replica} onPress={() => void schedule(190_000, 120_000, true)} className="min-h-12"><Text>Schedule multiple doses proof</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void take()} className="min-h-12"><Text>Take native proof</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void importReceipts()} className="min-h-12"><Text>Import medicine receipts</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void replayUndo()} className="min-h-12"><Text>Check undone receipt replay</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void quiescence()} className="min-h-12"><Text>Check quiescence race</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => settings?.openNotificationSettings()} className="min-h-12"><Text>Open medicine notification settings</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => settings?.openChannelSettings(MEDICINE_CHANNEL)} className="min-h-12"><Text>Open medicine reminder category</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => void clear()} className="min-h-12"><Text>Clear native proof</Text></Pressable>
  </View>;
}
