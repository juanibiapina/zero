import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createTaskdoReplica, defaultToastController, MedicineDraft, medicineOccurrences, medicineToday } from '@zero/agent-core';
import { createMergeableStore } from 'tinybase';
import type { ReactNode } from 'react';

import HomeScreen from '@/app/(todo)/index';
import { MedicinesList, MedicineDetail } from '../medicines';
import { createInMemoryTodoData, InMemoryTodoDataProvider } from '@/testing/in-memory-todo-data';

const mockNavigate = jest.fn();
const mockPush = jest.fn();
let mockParams: { id?: string; dose?: string } = {};
jest.mock('expo-router', () => ({
  router: { navigate: (href: string) => mockNavigate(href), push: (href: string) => mockPush(href), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@clerk/expo', () => ({ useAuth: () => ({ getToken: async () => 'token' }), useUser: () => ({ user: null }) }));

async function openScreen(children: ReactNode, data = createInMemoryTodoData()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const screen = await render(<QueryClientProvider client={client}><InMemoryTodoDataProvider data={data}>{children}</InMemoryTodoDataProvider></QueryClientProvider>);
  return { ...screen, data };
}

beforeEach(() => { mockNavigate.mockReset(); mockPush.mockReset(); mockParams = {}; defaultToastController.dismiss(); });

describe('Medicine creation and management', () => {
  it('keeps Medicine out of Home quick-add and creates three doses from its own list without Task rows', async () => {
    const data = createInMemoryTodoData();
    const home = await openScreen(<HomeScreen />, data);
    await fireEvent.press(home.getByLabelText('Add'));
    expect(home.queryByLabelText('Add a medicine')).toBeNull();
    await home.unmount();
    const screen = await openScreen(<MedicinesList />, data);
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await fireEvent.changeText(screen.getByLabelText('Medicine name'), 'Vitamin D');
    await fireEvent.press(screen.getByText('Once a day'));
    await fireEvent.press(screen.getByText('Three times a day'));
    expect(screen.getByText('08:00   ·   14:00   ·   20:00')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await waitFor(() => expect(screen.data.replica!.snapshot().medicines).toHaveLength(1));
    expect(screen.data.replica!.snapshot().medicines[0].doses.map((dose) => dose.alarmAt)).toEqual(['08:00', '14:00', '20:00']);
    expect(screen.data.replica!.snapshot().medicines[0].doses.map((dose) => dose.remindAt)).toEqual(['07:30', '13:30', '19:30']);
    expect(screen.data.replica!.snapshot().tasks).toHaveLength(0);
    expect(screen.queryByLabelText('Medicine name')).toBeNull();
    expect(screen.getByText('Vitamin D')).toBeTruthy();
  });
  it('opens Medicine directly from its list and accepts an optional description and finite course', async () => {
    const screen = await openScreen(<MedicinesList />);
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    expect(screen.getByLabelText('Medicine name')).toBeTruthy();
    expect(screen.queryByText('Task')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Medicine name'), 'Daily course');
    await fireEvent.press(screen.getByLabelText('Add description'));
    await fireEvent.changeText(screen.getByLabelText('Medicine description'), 'After food');
    await fireEvent.press(screen.getByLabelText('Customize medicine schedule'));
    await fireEvent.press(screen.getByText('Ongoing'));
    await fireEvent.press(screen.getByText('For a number of days'));
    await fireEvent.changeText(screen.getByLabelText('Number of days'), '10');
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await waitFor(() => expect(screen.queryByLabelText('Medicine name')).toBeNull());
    expect(screen.getByLabelText('Open Daily course')).toBeTruthy();
    expect(screen.data.replica!.snapshot().medicines[0]).toMatchObject({ instructions: 'After food', startsOn: medicineToday() });
    expect(screen.data.replica!.snapshot().medicines[0].endsOn).not.toBeNull();
  });
  it('keeps the draft visible until persistence succeeds and retries the same Medicine after failure', async () => {
    let fail = true;
    let release: () => void = () => {};
    const checkpoint = new Promise<void>((resolve) => { release = resolve; });
    const data = createInMemoryTodoData();
    data.replica = createTaskdoReplica({ store: createMergeableStore(), queryClient: new QueryClient(), queryKeyScope: ['medicine-ui-retry'], save: async () => { if (fail) throw new Error('Storage full'); await checkpoint; } });
    const screen = await openScreen(<MedicinesList />, data);
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await fireEvent.changeText(screen.getByLabelText('Medicine name'), 'Keep my draft');
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await waitFor(() => expect(screen.getByText('Storage full')).toBeTruthy());
    expect(screen.getByLabelText('Medicine name').props.value).toBe('Keep my draft');
    fail = false;
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    expect(screen.getByText('Saving…')).toBeTruthy();
    expect(screen.getByLabelText('Medicine name')).toBeTruthy();
    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByLabelText('Medicine name')).toBeNull());
    expect(data.replica.snapshot().medicines).toHaveLength(1);
    await data.replica.close();
  });
  it.each([false, true])('preserves a taken dose without Undo when editing its description (dose-focused: %s)', async (doseFocused) => {
    const data = createInMemoryTodoData();
    const input = MedicineDraft.create(medicineToday()).change({ name: 'Custom routine' }).commit();
    input.doses[0] = { id: 'evening', remindAt: '20:00', alarmAt: '22:00' };
    const medicine = await data.replica!.medicines.add(input);
    const dose = medicineOccurrences(medicine, medicineToday())[0];
    await data.replica!.medicines.take(dose);
    mockParams = { id: medicine.id, ...(doseFocused ? { dose: dose.id } : {}) };
    const screen = await openScreen(<MedicineDetail />, data);
    expect(screen.queryByText('Edit medicine')).toBeNull();
    expect(screen.queryByText('Taken at is the time you pressed Taken.')).toBeNull();
    expect(screen.getByText('22:00')).toBeTruthy();
    expect(screen.getByText(/Taken at /)).toBeTruthy();
    expect(screen.queryByLabelText(/Undo/)).toBeNull();
    const confirmation = data.replica!.snapshot().doses[0];
    await fireEvent.press(screen.getByLabelText('Medicine options'));
    await fireEvent.press(screen.getByLabelText('Edit medicine'));
    await fireEvent.press(screen.getByLabelText('Add description'));
    await fireEvent.changeText(screen.getByLabelText('Medicine description'), 'With dinner');
    await fireEvent.press(screen.getByLabelText('Save medicine'));
    await waitFor(() => expect(screen.queryByLabelText('Medicine name')).toBeNull());
    expect(data.replica!.snapshot().medicines[0].doses).toEqual(input.doses);
    expect(data.replica!.snapshot().doses[0]).toEqual(confirmation);
    await fireEvent.press(screen.getByLabelText('Dose history'));
    expect(screen.queryByText('Taken at is the time you pressed Taken.')).toBeNull();
    expect(screen.getAllByText(/Taken at /)).toHaveLength(2);
  });
  it('pauses and resumes reminders from Medicine options', async () => {
    const data = createInMemoryTodoData();
    const medicine = await data.replica!.medicines.add(MedicineDraft.create(medicineToday()).change({ name: 'Vitamin D' }).commit());
    mockParams = { id: medicine.id };
    const screen = await openScreen(<MedicineDetail />, data);
    await fireEvent.press(screen.getByLabelText('Medicine options'));
    await fireEvent.press(screen.getByText('Pause reminders'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].paused).toBe(true));
    expect(screen.getByText('Resume reminders')).toBeTruthy();
    await fireEvent.press(screen.getByText('Resume reminders'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].paused).toBe(false));
  });
  it('shows a pending dose without a manual Taken button', async () => {
    const data = createInMemoryTodoData();
    const medicine = await data.replica!.medicines.add(MedicineDraft.create(medicineToday()).change({ name: 'Vitamin D' }).commit());
    mockParams = { id: medicine.id };
    const screen = await openScreen(<MedicineDetail />, data);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('20:00')).toBeTruthy();
    expect(screen.queryByLabelText('Taken 20:00 dose')).toBeNull();
    expect(data.replica!.snapshot().doses).toHaveLength(0);
  });
  it('keeps creation open through native time selection and closes customization before discard on Back', async () => {
    const screen = await openScreen(<MedicinesList />);
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await fireEvent.changeText(screen.getByLabelText('Medicine name'), 'Evening routine');
    await fireEvent.press(screen.getByLabelText('Customize medicine schedule'));
    await fireEvent.press(screen.getByLabelText('Change dose 1 time, 20:00'));
    await act(async () => { (global as typeof globalThis & { __emitKeyboardEvent: (name: string) => void }).__emitKeyboardEvent('keyboardWillHide'); });
    expect(screen.queryByText('Discard changes?')).toBeNull();
    await fireEvent(screen.getByTestId('native-date-time-picker'), 'change', { type: 'set' }, new Date('2000-01-01T21:00:00'));
    expect(screen.getByLabelText('Change dose 1 time, 21:00')).toBeTruthy();
    expect(screen.getByLabelText('Change reminder 1, 20:00')).toBeTruthy();
    await fireEvent(screen.getByLabelText('Medicine name'), 'requestClose');
    expect(screen.queryByLabelText('Change dose 1 time, 21:00')).toBeNull();
    expect(screen.queryByText('Discard changes?')).toBeNull();
    await fireEvent(screen.getByLabelText('Medicine name'), 'requestClose');
    expect(screen.getByText('Discard changes?')).toBeTruthy();
  });

  it('retains a Medicine draft when discard is canceled and creates nothing on discard', async () => {
    const screen = await openScreen(<MedicinesList />);
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await fireEvent.changeText(screen.getByLabelText('Medicine name'), 'Draft routine');
    expect(screen.getByLabelText('Medicine name').props.value).toBe('Draft routine');
    await fireEvent.press(screen.getByLabelText('Dismiss medicine editor'));
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(screen.getByLabelText('Medicine name').props.value).toBe('Draft routine');
    await fireEvent.press(screen.getByLabelText('Dismiss medicine editor'));
    await fireEvent.press(screen.getByText('Discard'));
    expect(screen.data.replica!.snapshot().medicines).toHaveLength(0);
  });
});
