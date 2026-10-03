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
    openReminderSettings: jest.fn(), openFullScreenSettings: jest.fn(),
  },
}));
let replica: TaskdoReplica | null = null;
const foreground = new Set<(state: AppStateStatus) => void>();
beforeEach(async () => {
  await AsyncStorage.clear();
  mockCapabilities = { supported: true, notifications: true, exactAlarms: true, quietChannel: true, quietChannelImportance: 4, fullScreenAlarms: true, alarmChannel: true, alarmVolume: 5 };
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
  it('hides setup while enabled, warns after notifications are turned off, and hides after they are restored', async () => {
    const screen = await openMedicine();
    await waitFor(() => expect(screen.queryByLabelText('Reminders on this phone')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    mockCapabilities = { ...mockCapabilities, notifications: false };
    await act(async () => { for (const listener of foreground) listener('active'); });
    await waitFor(() => expect(screen.getByText('Notifications are off. Medicine reminders won’t appear.')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Notifications are off. Medicine reminders won’t appear.'));
    expect(screen.queryByText('Taken works offline. Changes on other devices arrive when this phone syncs.')).toBeNull();
    expect(screen.queryByLabelText('Turn off reminders on this phone')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Allow notifications'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByLabelText('Allow notifications')).toBeNull();
  });
  it('opens the reminder category settings when visibility is low and recovers on return', async () => {
    Object.assign(mockCapabilities, { quietChannelImportance: 2 });
    const screen = await openMedicine();
    const warning = 'Medicine reminders are set to Silent.';
    await waitFor(() => expect(screen.getByText(warning)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText(warning));
    await fireEvent.press(screen.getByLabelText('Show medicine reminders prominently'));
    const native = require('../../../modules/medicine-reminders').default;
    expect(native.openReminderSettings).toHaveBeenCalled();
    Object.assign(mockCapabilities, { quietChannelImportance: 4 });
    await act(async () => { for (const listener of foreground) listener('active'); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('offers full-screen alarm settings and recovers when access is enabled', async () => {
    Object.assign(mockCapabilities, { fullScreenAlarms: false });
    const screen = await openMedicine();
    const warning = 'Full-screen medicine alarms are blocked.';
    await waitFor(() => expect(screen.getByText(warning)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText(warning));
    await fireEvent.press(screen.getByLabelText('Allow full-screen alarms'));
    const native = require('../../../modules/medicine-reminders').default;
    expect(native.openFullScreenSettings).toHaveBeenCalled();
    Object.assign(mockCapabilities, { fullScreenAlarms: true });
    await act(async () => { for (const listener of foreground) listener('active'); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('warns when phone reminders are off and hides after enabling them', async () => {
    const screen = await openMedicine(false);
    await waitFor(() => expect(screen.getByText('Medicine reminders are off on this phone.')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Medicine reminders are off on this phone.'));
    await fireEvent.press(screen.getByLabelText('Enable reminders on this phone'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByLabelText('Turn off reminders on this phone')).toBeNull();
  });
  it.each([
    { capability: 'exactAlarms', value: false, warning: 'Medicine alarms are blocked.', action: 'Allow exact alarms' },
    { capability: 'quietChannel', value: false, warning: 'Medicine notifications are blocked.', action: 'Enable medicine notification channels' },
    { capability: 'alarmVolume', value: 0, warning: 'Alarm volume is off.', action: 'Set alarm volume' },
  ])('warns about $capability instead of hiding a blocked delivery setup', async ({ capability, value, warning, action }) => {
    mockCapabilities = { ...mockCapabilities, [capability]: value };
    const screen = await openMedicine();
    await waitFor(() => expect(screen.getByText(warning)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText(warning));
    expect(screen.getByLabelText(action)).toBeTruthy();
    expect(screen.queryByLabelText('Turn off reminders on this phone')).toBeNull();
  });
});
