import { requireOptionalNativeModule } from 'expo';
import type { MedicineReceipt, MedicineReminderPort } from '@zero/agent-core';

export type ReminderCapabilities = {
  notifications: boolean;
  alertChannel: boolean;
  exactAlarms: boolean;
  backgroundRestricted: boolean;
};

export type MedicineReminderDevice = MedicineReminderPort & {
  clear(workspace: string): Promise<void>;
};

export type ReminderSettings = {
  capabilities(): Promise<ReminderCapabilities>;
  requestNotifications(): void;
  openNotificationSettings(): void;
  openReminderSettings(): void;
  openExactAlarmSettings(): void;
  openBatterySettings(): void;
};

export type MedicineReminderProof = {
  silenceProof(): Promise<void>;
};

type NativeMedicineReminders = {
  capabilities(): Promise<ReminderCapabilities>;
  silenceProof(): Promise<void>;
  replace(workspace: string, plan: string): Promise<void>;
  receipts(workspace: string): Promise<string>;
  acknowledge(workspace: string, actionIds: string): Promise<void>;
  take(workspace: string, dose: string): Promise<string>;
  quiesce(workspace: string): Promise<void>;
  clear(workspace: string): Promise<void>;
  requestNotifications(): void;
  openNotificationSettings(): void;
  openReminderSettings(): void;
  openExactAlarmSettings(): void;
  openBatterySettings(): void;
};

const native = typeof requireOptionalNativeModule === 'function'
  ? requireOptionalNativeModule<NativeMedicineReminders>('MedicineReminders')
  : null;

export const medicineReminderDevice: MedicineReminderDevice | null = native && {
  replace: (workspace, plan) => native.replace(workspace, JSON.stringify(plan)),
  receipts: async (workspace) => JSON.parse(await native.receipts(workspace)) as MedicineReceipt[],
  acknowledge: (workspace, actionIds) => native.acknowledge(workspace, JSON.stringify(actionIds)),
  take: async (workspace, dose) => JSON.parse(await native.take(workspace, JSON.stringify(dose))) as MedicineReceipt,
  quiesce: (workspace) => native.quiesce(workspace),
  clear: (workspace) => native.clear(workspace),
};

export const reminderSettings: ReminderSettings | null = native && {
  async capabilities() {
    const { notifications, alertChannel, exactAlarms, backgroundRestricted } = await native.capabilities();
    return { notifications, alertChannel, exactAlarms, backgroundRestricted };
  },
  requestNotifications: () => native.requestNotifications(),
  openNotificationSettings: () => native.openNotificationSettings(),
  openReminderSettings: () => native.openReminderSettings(),
  openExactAlarmSettings: () => native.openExactAlarmSettings(),
  openBatterySettings: () => native.openBatterySettings(),
};

export const medicineReminderProof: MedicineReminderProof | null = native && {
  silenceProof: () => native.silenceProof(),
};
