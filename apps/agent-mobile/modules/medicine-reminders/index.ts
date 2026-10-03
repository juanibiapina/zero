import { requireOptionalNativeModule } from 'expo';

export type ReminderCapabilities = {
  supported: boolean; notifications: boolean; exactAlarms: boolean;
  quietChannel: boolean; alarmChannel: boolean; alarmVolume: number;
  quietChannelImportance: number; fullScreenAlarms: boolean;
};
type MedicineReminders = {
  capabilities(): Promise<ReminderCapabilities>;
  silenceProof(): Promise<void>;
  replace(workspace: string, payload: string): Promise<void>;
  receipts(workspace: string): Promise<string>;
  acknowledge(workspace: string, ids: string): Promise<void>;
  take(workspace: string, dose: string): Promise<string>;
  quiesce(workspace: string): Promise<void>;
  clear(workspace: string): Promise<void>;
  requestNotifications(): void;
  openExactAlarmSettings(): void;
  openNotificationSettings(): void;
  openReminderSettings(): void;
  openFullScreenSettings(): void;
  openSoundSettings(): void;
};
export default typeof requireOptionalNativeModule === 'function' ? requireOptionalNativeModule<MedicineReminders>('MedicineReminders') : null;
