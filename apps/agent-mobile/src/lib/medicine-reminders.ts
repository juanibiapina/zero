import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { createMedicineReminders, type MedicineReminders, type TaskdoReplica } from '@zero/agent-core';
import NativeReminders from '../../modules/medicine-reminders';

const controllers = new WeakMap<TaskdoReplica, MedicineReminders>();
export const getMedicineReminders = (replica: TaskdoReplica | null) => replica ? controllers.get(replica) ?? null : null;
const enabledKey = (workspace: string) => `zero.medicine-reminders.enabled.${workspace}`;

export async function attachMedicineReminders(replica: TaskdoReplica, workspace: string): Promise<TaskdoReplica> {
  if (!NativeReminders) return replica;
  const reminders = createMedicineReminders(replica, NativeReminders, workspace);
  const wasEnabled = await AsyncStorage.getItem(enabledKey(workspace)) === '1';
  // Import before exposing the workspace or allowing a native plan to replace
  // the previous process's pending notification confirmations.
  try {
    await reminders.refresh();
    if (wasEnabled) await reminders.enable();
  } catch (error) {
    await reminders.close();
    throw error;
  }
  const refresh = () => void reminders.refresh().catch(() => {});
  const foreground = AppState.addEventListener('change', (state) => {
    if (state === 'active') refresh();
  });
  const focus = AppState.addEventListener('focus', refresh);
  const wrapped: TaskdoReplica & { checkpoint?: () => Promise<void> } = {
    ...replica,
    medicines: {
      ...replica.medicines,
      take: (dose) => reminders.take(dose),
      undo: (id) => reminders.undo(id),
      async add(input, creationId) {
        const result = await replica.medicines.add(input, creationId);
        // A saved routine still opens its detail if only delivery setup fails.
        // The controller exposes that failure there without creating a duplicate.
        await reminders.refresh().catch(() => {});
        return result;
      },
      async edit(id, input) { await replica.medicines.edit(id, input); await reminders.refresh(); },
      async remove(id) { await replica.medicines.remove(id); await reminders.refresh(); },
    },
    async checkpoint() {
      await reminders.checkpoint();
      try {
        const original = replica as TaskdoReplica & { checkpoint?: () => Promise<void> };
        await original.checkpoint?.();
      } catch (error) { await reminders.resume(); throw error; }
    },
    async close() {
      foreground.remove();
      focus.remove();
      await reminders.close();
      await replica.close();
    },
  };
  controllers.set(wrapped, reminders);
  return wrapped;
}

export async function enableMedicineReminders(replica: TaskdoReplica, workspace: string) {
  const controller = controllers.get(replica);
  if (!controller) throw new Error('Install an Android build with medicine reminder support');
  await AsyncStorage.setItem(enabledKey(workspace), '1');
  await controller.enable();
}
export async function clearMedicineReminders(workspace: string) {
  await NativeReminders?.clear(workspace);
  await AsyncStorage.removeItem(enabledKey(workspace));
}
export { NativeReminders };
