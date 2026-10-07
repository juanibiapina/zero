import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { createMedicineReminders, MEDICINE_CHANNEL, type MedicineReminders, type NotificationCapabilities, type TaskdoReplica } from '@zero/agent-core';
import { notificationDevice, notificationSettings, type NotificationSettings } from '../../modules/zero-notifications';

const controllers = new WeakMap<TaskdoReplica, MedicineReminders>();
const enabledKey = (workspace: string) => `zero.medicine-reminders.enabled.${workspace}`;

export async function attachMedicineReminders(replica: TaskdoReplica, workspace: string): Promise<TaskdoReplica> {
  if (!notificationDevice) return replica;
  const reminders = createMedicineReminders(replica, notificationDevice, workspace);
  const wasEnabled = await AsyncStorage.getItem(enabledKey(workspace)) === '1';
  // Import before exposing the workspace or allowing a native plan to replace
  // the previous process's pending notification confirmations.
  try {
    await reminders.refresh();
  } catch (error) {
    await reminders.close();
    throw error;
  }
  if (wasEnabled) await reminders.enable().catch(() => {});
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

export async function clearMedicineReminders(workspace: string) {
  await notificationDevice?.clear(workspace);
  await AsyncStorage.removeItem(enabledKey(workspace));
}

type MedicineReminderNotice = { message: string; action: string; pending: boolean; fix: () => Promise<void> };

type ReminderIssue = { kind?: 'notifications'; message: string; action: string; fix: () => unknown };

async function enable(controller: MedicineReminders) {
  await AsyncStorage.setItem(enabledKey(controller.workspace), '1');
  await controller.enable();
}

function reminderIssue(controller: MedicineReminders, settings: NotificationSettings, enabled: boolean, failed: boolean, askedForNotifications: boolean, capabilities: NotificationCapabilities): ReminderIssue | null {
  if (failed) return { message: 'Reminders couldn’t be scheduled.', action: 'Try again', fix: () => controller.refresh() };
  if (!enabled) return { message: 'Reminders are off on this phone.', action: 'Turn on', fix: () => enable(controller) };
  if (!capabilities.notifications) return { kind: 'notifications', message: 'Notifications are off, so reminders won’t appear.', action: 'Allow notifications', fix: () => askedForNotifications ? settings.openNotificationSettings() : settings.requestNotifications() };
  if (capabilities.channels[MEDICINE_CHANNEL] === false) return { message: 'Medicine notifications are turned off.', action: 'Open settings', fix: () => settings.openChannelSettings(MEDICINE_CHANNEL) };
  if (!capabilities.exactAlarms) return { message: 'Reminders can’t arrive on time.', action: 'Allow', fix: () => settings.openExactAlarmSettings() };
  if (capabilities.backgroundRestricted) return { message: 'Battery restrictions may delay reminders.', action: 'Battery settings', fix: () => settings.openBatterySettings() };
  return null;
}

export function useMedicineReminderNotice(replica: TaskdoReplica | null): MedicineReminderNotice | null {
  const controller = replica ? controllers.get(replica) ?? null : null;
  const [capabilities, setCapabilities] = useState<NotificationCapabilities | null>(null);
  const [delivery, setDelivery] = useState(() => ({ controller, state: controller?.getState() }));
  const state = delivery.controller === controller ? delivery.state : controller?.getState();
  const [failed, setFailed] = useState(false);
  const [askedForNotifications, setAskedForNotifications] = useState(false);
  const refresh = useCallback(() => { void notificationSettings?.capabilities().then(setCapabilities).catch(() => setFailed(true)); }, []);
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', (value) => { if (value === 'active') refresh(); });
    const unsubscribe = controller?.subscribe(() => setDelivery({ controller, state: controller.getState() }));
    return () => { subscription.remove(); unsubscribe?.(); };
  }, [controller, refresh]);
  if (!notificationSettings || !controller || !capabilities) return null;
  const settings = notificationSettings;
  const issue = reminderIssue(controller, settings, !!state?.enabled, failed || !!state?.error, askedForNotifications, capabilities);
  if (!issue) return null;
  return {
    message: issue.message,
    action: issue.action,
    pending: !!state?.pending,
    async fix() {
      setFailed(false);
      try { await issue.fix(); if (issue.kind === 'notifications') setAskedForNotifications(true); setCapabilities(await settings.capabilities()); }
      catch { setFailed(true); }
    },
  };
}
