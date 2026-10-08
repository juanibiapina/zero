import { requireOptionalNativeModule } from 'expo';
import type { NotificationCapabilities, NotificationDevice, NotificationReceipt } from '@zero/agent-core';

export type NotificationSettings = {
  capabilities(): Promise<NotificationCapabilities>;
  requestNotifications(): void;
  openNotificationSettings(): void;
  openChannelSettings(channel: string): void;
  openExactAlarmSettings(): void;
  openFullScreenSettings(): void;
  openBatterySettings(): void;
};

export type NotificationProof = {
  silence(workspace: string): Promise<void>;
};

type NativeZeroNotifications = {
  install(workspace: string, source: string, schedule: string): Promise<void>;
  receipts(workspace: string, source: string): Promise<string>;
  acknowledge(workspace: string, source: string, ids: string[]): Promise<void>;
  settle(workspace: string, source: string, key: string, date: string, action: string): Promise<string>;
  quiesce(workspace: string): Promise<void>;
  clear(workspace: string): Promise<void>;
  capabilities(): Promise<NotificationCapabilities>;
  silence(workspace: string): Promise<void>;
  requestNotifications(): void;
  openNotificationSettings(): void;
  openChannelSettings(channel: string): void;
  openExactAlarmSettings(): void;
  openFullScreenSettings(): void;
  openBatterySettings(): void;
};

const native = typeof requireOptionalNativeModule === 'function'
  ? requireOptionalNativeModule<NativeZeroNotifications>('ZeroNotifications')
  : null;

export const notificationDevice: NotificationDevice | null = native && {
  install: (workspace, source, schedule) => native.install(workspace, source, JSON.stringify(schedule)),
  receipts: async (workspace, source) => JSON.parse(await native.receipts(workspace, source)) as NotificationReceipt[],
  acknowledge: (workspace, source, ids) => native.acknowledge(workspace, source, ids),
  settle: async (workspace, source, key, date, action) => JSON.parse(await native.settle(workspace, source, key, date, action)) as NotificationReceipt,
  quiesce: (workspace) => native.quiesce(workspace),
  clear: (workspace) => native.clear(workspace),
};

export const notificationSettings: NotificationSettings | null = native && {
  capabilities: () => native.capabilities(),
  requestNotifications: () => native.requestNotifications(),
  openNotificationSettings: () => native.openNotificationSettings(),
  openChannelSettings: (channel) => native.openChannelSettings(channel),
  openExactAlarmSettings: () => native.openExactAlarmSettings(),
  openFullScreenSettings: () => native.openFullScreenSettings(),
  openBatterySettings: () => native.openBatterySettings(),
};

export const notificationProof: NotificationProof | null = native && {
  silence: (workspace) => native.silence(workspace),
};
