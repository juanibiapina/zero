import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MedicineDraft, medicineToday, type TaskdoReplica } from '@zero/agent-core';
import { AppState, type AppStateStatus } from 'react-native';
import type { ReminderCapabilities } from '../../../modules/medicine-reminders';
import { MedicineDetail } from '../medicines';
import { attachMedicineReminders, enableMedicineReminders } from '@/lib/medicine-reminders';
import { createInMemoryTodoData, InMemoryTodoDataProvider } from '@/testing/in-memory-todo-data';

let mockParams: { id?: string } = {};
let mockCapabilities: ReminderCapabilities;
jest.mock('expo-router', () => ({ router: { replace: jest.fn(), back: jest.fn() }, useLocalSearchParams: () => mockParams }));
jest.mock('@clerk/expo', () => ({ useAuth: () => ({ getToken: async () => 'token' }), useUser: () => ({ user: null }) }));
jest.mock('../../../modules/medicine-reminders', () => ({
  __esModule: true,
  default: {
    capabilities: async () => mockCapabilities,
    receipts: async () => '[]',
    replace: async () => {}, acknowledge: async () => {}, quiesce: async () => {}, clear: async () => {},
    requestNotifications: () => { mockCapabilities = { ...mockCapabilities, notifications: true }; },
    openExactAlarmSettings: () => {}, openNotificationSettings: () => {}, openSoundSettings: () => {},
    openReminderSettings: jest.fn(), openBatterySettings: jest.fn(),
  },
}));
let replica: TaskdoReplica | null = null;
const foreground = new Set<(state: AppStateStatus) => void>();
beforeEach(async () => {
  await AsyncStorage.clear();
  mockCapabilities = { notifications: true, exactAlarms: true, alertChannel: true, alertChannelImportance: 4,
    channelSound: true, notificationVolume: 5, ringerNormal: true,
    backgroundRestricted: false, batteryExempt: false };
  foreground.clear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'change') foreground.add(listener);
    return { remove: () => { foreground.delete(listener); } };
  });
});
afterEach(async () => { await replica?.close(); replica = null; jest.restoreAllMocks(); });
async function openMedicine(enabled = true) {
  const data = createInMemoryTodoData();
  const medicine = await data.replica!.medicines.add(MedicineDraft.create(medicineToday()).change({ name: 'Evening medicine' }).commit());
  mockParams = { id: medicine.id };
  replica = await attachMedicineReminders(data.replica!, 'medicine-warning-test');
  data.replica = replica;
  if (enabled) await enableMedicineReminders(replica, 'medicine-warning-test');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><InMemoryTodoDataProvider data={data}><MedicineDetail /></InMemoryTodoDataProvider></QueryClientProvider>);
}
describe('Medicine reminder warnings', () => {
  it('reports notification permission changes when returning to the app', async () => {
    const screen = await openMedicine();
    await waitFor(() => expect(screen.getByLabelText('Reminders on this phone')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    mockCapabilities = { ...mockCapabilities, notifications: false };
    await act(async () => { for (const listener of foreground) listener('active'); });
    const warning = 'Notifications are off. Medicine reminders won’t appear.';
    await waitFor(() => expect(screen.getByText(warning)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText(warning));
    expect(screen.getByLabelText('All notification settings')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Allow notifications'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('detects a silent channel even when its importance is high', async () => {
    Object.assign(mockCapabilities, { channelSound: false });
    const screen = await openMedicine();
    const warning = 'Medicine reminders appear without sound.';
    await waitFor(() => expect(screen.getByText(warning)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText(warning));
    await fireEvent.press(screen.getByLabelText('Medicine notification settings'));
    const native = require('../../../modules/medicine-reminders').default;
    expect(native.openReminderSettings).toHaveBeenCalled();
    Object.assign(mockCapabilities, { channelSound: true });
    await act(async () => { for (const listener of foreground) listener('active'); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('keeps battery and watch setup accessible without treating missing exemption as blocked delivery', async () => {
    const screen = await openMedicine();
    await waitFor(() => expect(screen.getByLabelText('Reminders on this phone')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Reminders on this phone'));
    await fireEvent.press(screen.getByLabelText('App battery settings'));
    const native = require('../../../modules/medicine-reminders').default;
    expect(native.openBatterySettings).toHaveBeenCalled();
    expect(screen.getByText(/allow Zero Agent notifications in your watch companion app/)).toBeTruthy();
    expect(screen.queryByLabelText('Allow full-screen alarms')).toBeNull();
    expect(screen.queryByLabelText('Set alarm volume')).toBeNull();
  });
  it('warns when phone reminders are off and recovers after enabling them', async () => {
    const screen = await openMedicine(false);
    const warning = 'Medicine reminders are off on this phone.';
    await waitFor(() => expect(screen.getByText(warning)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText(warning));
    await fireEvent.press(screen.getByLabelText('Enable reminders on this phone'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it.each([
    { capability: 'exactAlarms', value: false, warning: 'On-time medicine reminders are blocked.', action: 'Allow exact alarms' },
    { capability: 'alertChannel', value: false, warning: 'Medicine notifications are blocked.', action: 'Medicine notification settings' },
    { capability: 'notificationVolume', value: 0, warning: 'Phone notification sound is muted. Medicine reminders still appear.', action: 'Phone sound settings' },
    { capability: 'ringerNormal', value: false, warning: 'Phone notification sound is muted. Medicine reminders still appear.', action: 'Phone sound settings' },
    { capability: 'backgroundRestricted', value: true, warning: 'Background activity is restricted. Medicine reminders may be delayed.', action: 'App battery settings' },
    { capability: 'alertChannelImportance', value: 2, warning: 'Medicine reminders appear without sound.', action: 'Medicine notification settings' },
  ])('reports $capability accurately', async ({ capability, value, warning, action }) => {
    mockCapabilities = { ...mockCapabilities, [capability]: value };
    const screen = await openMedicine();
    await waitFor(() => expect(screen.getByText(warning)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText(warning));
    expect(screen.getByLabelText(action)).toBeTruthy();
  });
});
