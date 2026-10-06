import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createInMemoryMedicineReminderDevice, MedicineDraft, medicineToday, type InMemoryMedicineReminderDevice, type TaskdoReplica } from '@zero/agent-core';
import type { ReactElement } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { reminderSettings, type ReminderCapabilities } from '../../../modules/medicine-reminders';
import { MedicineDetail, MedicinesList } from '../medicines';
import { attachMedicineReminders } from '@/lib/medicine-reminders';
import { createInMemoryTodoData, InMemoryTodoDataProvider } from '@/testing/in-memory-todo-data';

let mockParams: { id?: string } = {};
let mockCapabilities: ReminderCapabilities;
let mockDevice: InMemoryMedicineReminderDevice;
jest.mock('expo-router', () => ({ router: { replace: jest.fn(), back: jest.fn(), push: jest.fn() }, useLocalSearchParams: () => mockParams }));
jest.mock('@clerk/expo', () => ({ useAuth: () => ({ getToken: async () => 'token' }), useUser: () => ({ user: null }) }));
jest.mock('../../../modules/medicine-reminders', () => ({
  __esModule: true,
  get medicineReminderDevice() { return mockDevice; },
  reminderSettings: {
    capabilities: async () => mockCapabilities,
    requestNotifications: jest.fn(), openNotificationSettings: jest.fn(),
    openExactAlarmSettings: jest.fn(), openReminderSettings: jest.fn(), openBatterySettings: jest.fn(),
  },
  medicineReminderProof: null,
}));
const settings = () => reminderSettings as unknown as Record<string, jest.Mock>;
let replica: TaskdoReplica | null = null;
const foreground = new Set<(state: AppStateStatus) => void>();
const returnToApp = () => act(async () => { for (const listener of foreground) listener('active'); });
beforeEach(async () => {
  await AsyncStorage.clear();
  mockDevice = createInMemoryMedicineReminderDevice();
  mockCapabilities = { notifications: true, exactAlarms: true, alertChannel: true, backgroundRestricted: false };
  foreground.clear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'change') foreground.add(listener);
    return { remove: () => { foreground.delete(listener); } };
  });
});
afterEach(async () => { await replica?.close(); replica = null; jest.clearAllMocks(); jest.restoreAllMocks(); });
async function open(screen: ReactElement, { enabled = true } = {}) {
  const data = createInMemoryTodoData();
  const medicine = await data.replica!.medicines.add(MedicineDraft.create(medicineToday()).change({ name: 'Evening medicine' }).commit());
  mockParams = { id: medicine.id };
  replica = await attachMedicineReminders(data.replica!, 'medicine-warning-test');
  data.replica = replica;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rendered = await render(<QueryClientProvider client={client}><InMemoryTodoDataProvider data={data}>{screen}</InMemoryTodoDataProvider></QueryClientProvider>);
  await waitFor(() => expect(rendered.getByText('Evening medicine')).toBeTruthy());
  if (enabled) {
    await waitFor(() => expect(rendered.getByLabelText('Turn on')).toBeTruthy());
    await fireEvent.press(rendered.getByLabelText('Turn on'));
    await waitFor(() => expect(rendered.queryByText('Reminders are off on this phone.')).toBeNull());
  }
  return rendered;
}

describe('Medicine reminder notice', () => {
  it('shows no reminder text when reminders work', async () => {
    const screen = await open(<MedicinesList />);
    await returnToApp();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Reminders on this phone|watch|battery/i)).toBeNull();
  });

  it.each([
    { capability: 'alertChannel', value: false, message: 'Medicine notifications are turned off.', action: 'Open settings', opens: 'openReminderSettings' },
    { capability: 'exactAlarms', value: false, message: 'Reminders can’t arrive on time.', action: 'Allow', opens: 'openExactAlarmSettings' },
    { capability: 'backgroundRestricted', value: true, message: 'Battery restrictions may delay reminders.', action: 'Battery settings', opens: 'openBatterySettings' },
  ])('offers one fix when $capability blocks reminders', async ({ capability, value, message, action, opens }) => {
    mockCapabilities = { ...mockCapabilities, [capability]: value };
    const screen = await open(<MedicinesList />);
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText(action));
    expect(settings()[opens]).toHaveBeenCalled();
  });

  it('asks for notification permission, then opens settings if it stays off, and clears once allowed', async () => {
    mockCapabilities = { ...mockCapabilities, notifications: false };
    const screen = await open(<MedicinesList />);
    const message = 'Notifications are off, so reminders won’t appear.';
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Allow notifications'));
    expect(settings().requestNotifications).toHaveBeenCalled();
    expect(settings().openNotificationSettings).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('Allow notifications'));
    expect(settings().openNotificationSettings).toHaveBeenCalled();
    mockCapabilities = { ...mockCapabilities, notifications: true };
    await returnToApp();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('turns reminders on from the notice', async () => {
    const screen = await open(<MedicinesList />, { enabled: false });
    await waitFor(() => expect(screen.getByText('Reminders are off on this phone.')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Turn on'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('retries scheduling after a failure', async () => {
    const screen = await open(<MedicinesList />);
    mockDevice.failReplacement = true;
    await returnToApp();
    await waitFor(() => expect(screen.getByText('Reminders couldn’t be scheduled.')).toBeTruthy());
    mockDevice.failReplacement = false;
    await fireEvent.press(screen.getByLabelText('Try again'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('keeps reminder setup off the medicine detail page', async () => {
    const screen = await open(<MedicineDetail />, { enabled: false });
    await returnToApp();
    expect(screen.queryByText('Reminders are off on this phone.')).toBeNull();
  });
});
