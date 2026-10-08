import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createTaskdoReplica, defaultToastController, MedicineDraft, medicineEndDate, medicineOccurrences, medicineToday, type MedicineInput, type Weekday } from '@zero/agent-core';
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

const takenToast = () => defaultToastController.getSnapshot()[0];

async function openMedicine(over: Partial<MedicineInput> = {}) {
  const data = createInMemoryTodoData();
  const medicine = await data.replica!.medicines.add({ ...MedicineDraft.create(medicineToday()).change({ name: 'Vitamin D' }).commit(), ...over });
  mockParams = { id: medicine.id };
  const screen = await openScreen(<MedicineDetail />, data);
  return { screen, data, medicine };
}

describe('Adding a medicine', () => {
  it('keeps Medicine out of Home quick-add and adds three doses from its list, then opens it', async () => {
    const data = createInMemoryTodoData();
    const home = await openScreen(<HomeScreen />, data);
    await fireEvent.press(home.getByLabelText('Add'));
    expect(home.queryByLabelText('Add a medicine')).toBeNull();
    await home.unmount();
    const screen = await openScreen(<MedicinesList />, data);
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await fireEvent.changeText(screen.getByLabelText('Medicine name'), 'Vitamin D');
    await fireEvent.press(screen.getByLabelText('3 times a day'));
    expect(screen.getByText('14:00 · 1 pill')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await waitFor(() => expect(data.replica!.snapshot().medicines).toHaveLength(1));
    const [medicine] = data.replica!.snapshot().medicines;
    expect(medicine.doses.map((dose) => [dose.alarmAt, dose.remindAt])).toEqual([['08:00', '07:30'], ['14:00', '13:30'], ['20:00', '19:30']]);
    expect(data.replica!.snapshot().tasks).toHaveLength(0);
    expect(mockPush).toHaveBeenCalledWith(`/browse/medicines/${medicine.id}`);
    expect(screen.getByText('08:00 · 1 pill')).toBeTruthy();
  });
  it('saves notes, chosen weekdays, pills per dose and a ten-day course', async () => {
    const screen = await openScreen(<MedicinesList />);
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await fireEvent.changeText(screen.getByLabelText('Medicine name'), 'Antibiotic');
    await fireEvent.press(screen.getByLabelText('Add description'));
    await fireEvent.changeText(screen.getByLabelText('Medicine description'), 'After food');
    for (const name of ['Tuesday', 'Thursday', 'Saturday', 'Sunday']) await fireEvent.press(screen.getByLabelText(name));
    await fireEvent.press(screen.getByLabelText('Dose at 20:00, 1 pill. Change'));
    await fireEvent.press(screen.getByLabelText('More pills'));
    await fireEvent.press(screen.getByLabelText('Done'));
    await fireEvent.press(screen.getByLabelText('Set a last day'));
    expect(screen.getByText('10 days')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await waitFor(() => expect(screen.data.replica!.snapshot().medicines).toHaveLength(1));
    expect(screen.data.replica!.snapshot().medicines[0]).toMatchObject({
      instructions: 'After food', weekdays: [1, 3, 5], startsOn: medicineToday(), endsOn: medicineEndDate(medicineToday(), 10),
      doses: [expect.objectContaining({ alarmAt: '20:00', amount: 2 })],
    });
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
  it('closes the time picker, then the dose, before asking to discard on Back', async () => {
    const screen = await openScreen(<MedicinesList />);
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await fireEvent.changeText(screen.getByLabelText('Medicine name'), 'Evening routine');
    await fireEvent.press(screen.getByLabelText('Dose at 20:00, 1 pill. Change'));
    await fireEvent.press(screen.getByLabelText('Change time, 20:00'));
    await fireEvent(screen.getByTestId('native-date-time-picker'), 'change', { type: 'set' }, new Date('2000-01-01T21:00:00'));
    expect(screen.getByLabelText('Change time, 21:00')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Change time, 21:00'));
    await fireEvent(screen.getByLabelText('Medicine name'), 'requestClose');
    expect(screen.queryByTestId('native-date-time-picker')).toBeNull();
    await fireEvent(screen.getByLabelText('Medicine name'), 'requestClose');
    expect(screen.queryByLabelText('Change time, 21:00')).toBeNull();
    expect(screen.queryByText('Discard changes?')).toBeNull();
    await fireEvent(screen.getByLabelText('Medicine name'), 'requestClose');
    expect(screen.getByText('Discard changes?')).toBeTruthy();
  });
  it('retains a Medicine draft when discard is canceled and creates nothing on discard', async () => {
    const screen = await openScreen(<MedicinesList />);
    await fireEvent.press(screen.getByLabelText('Add medicine'));
    await fireEvent.changeText(screen.getByLabelText('Medicine name'), 'Draft routine');
    await fireEvent.press(screen.getByLabelText('Dismiss medicine editor'));
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(screen.getByLabelText('Medicine name').props.value).toBe('Draft routine');
    await fireEvent.press(screen.getByLabelText('Dismiss medicine editor'));
    await fireEvent.press(screen.getByText('Discard'));
    expect(screen.data.replica!.snapshot().medicines).toHaveLength(0);
  });
});

describe('A medicine page', () => {
  it('shows the pills of each dose in the list', async () => {
    const data = createInMemoryTodoData();
    const input = MedicineDraft.create(medicineToday()).change({ name: 'Ibuprofen' }).commit();
    await data.replica!.medicines.add({ ...input, doses: [{ ...input.doses[0], amount: 2 }] });
    const screen = await openScreen(<MedicinesList />, data);
    expect(screen.getByText('20:00 · 2 pills')).toBeTruthy();
  });
  it('takes a dose with a tap on its tile and undoes it from the toast', async () => {
    const { screen, data } = await openMedicine();
    expect(screen.getByText('Today')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Take 20:00 dose, 1 pill'));
    await waitFor(() => expect(data.replica!.snapshot().doses.filter((dose) => dose.takenAt)).toHaveLength(1));
    expect(screen.getByText(/Taken at /)).toBeTruthy();
    expect(takenToast()?.message).toBe('20:00 dose taken');
    await act(async () => { takenToast()!.action!.onPress(); });
    await waitFor(() => expect(data.replica!.snapshot().doses[0].takenAt).toBeNull());
    expect(screen.getByLabelText('Take 20:00 dose, 1 pill')).toBeTruthy();
  });
  it('undoes a taken dose through a long press and a confirmation', async () => {
    const data = createInMemoryTodoData();
    const medicine = await data.replica!.medicines.add(MedicineDraft.create(medicineToday()).change({ name: 'Vitamin D' }).commit());
    await data.replica!.medicines.take(medicineOccurrences(medicine, medicineToday())[0]);
    mockParams = { id: medicine.id };
    const screen = await openScreen(<MedicineDetail />, data);
    await fireEvent(screen.getByLabelText(/^20:00 dose, taken at /), 'longPress');
    await fireEvent.press(screen.getByLabelText('Cancel'));
    expect(data.replica!.snapshot().doses[0].takenAt).not.toBeNull();
    await fireEvent(screen.getByLabelText(/^20:00 dose, taken at /), 'longPress');
    expect(screen.getByText('Mark 20:00 dose as not taken?')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Undo'));
    await waitFor(() => expect(data.replica!.snapshot().doses[0].takenAt).toBeNull());
  });
  it('moves a dose time in place by 15 minutes and keeps its reminder lead', async () => {
    const { screen, data } = await openMedicine();
    await fireEvent(screen.getByTestId('dose-track'), 'layout', { nativeEvent: { layout: { width: 240, height: 48, x: 0, y: 0 } } });
    await fireEvent(screen.getByLabelText('Dose at 20:00'), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].doses[0]).toMatchObject({ alarmAt: '20:15', remindAt: '19:15' }));
    expect(screen.getByLabelText('Dose at 20:15')).toBeTruthy();
  });
  it('adds a dose where the day track is tapped', async () => {
    const { screen, data } = await openMedicine();
    const track = screen.getByTestId('dose-track');
    await fireEvent(track, 'layout', { nativeEvent: { layout: { width: 240, height: 48, x: 0, y: 0 } } });
    await fireEvent.press(track, { nativeEvent: { locationX: 120 } });
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].doses.map((dose) => dose.alarmAt).sort()).toEqual(['12:00', '20:00']));
  });
  it('changes pills and the reminder of a dose in place, and removes all but the last dose', async () => {
    const { screen, data } = await openMedicine();
    await fireEvent.press(screen.getByLabelText('Dose at 20:00, 1 pill. Change'));
    expect(screen.queryByLabelText('Remove 20:00 dose')).toBeNull();
    await fireEvent.press(screen.getByLabelText('More pills'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].doses[0].amount).toBe(2));
    await fireEvent.press(screen.getByLabelText('Remind 30 min before'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].doses[0].remindAt).toBe('19:30'));
    await fireEvent.press(screen.getByLabelText('Done'));
    await fireEvent.press(screen.getByLabelText('Add dose time'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].doses).toHaveLength(2));
    await fireEvent.press(screen.getByLabelText('Dose at 20:00, 2 pills. Change'));
    await fireEvent.press(screen.getByLabelText('Remove 20:00 dose'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].doses.map((dose) => dose.alarmAt)).toEqual(['08:00']));
  });
  it('toggles weekdays in place', async () => {
    const { screen, data } = await openMedicine();
    await fireEvent.press(screen.getByLabelText('Sunday'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].weekdays).toEqual([1, 2, 3, 4, 5, 6]));
  });
  it.each([false, true])('keeps a taken dose when editing the notes (dose-focused: %s)', async (doseFocused) => {
    const data = createInMemoryTodoData();
    const input = MedicineDraft.create(medicineToday()).change({ name: 'Custom routine' }).commit();
    input.doses[0] = { id: 'evening', remindAt: '20:00', alarmAt: '22:00', amount: 1 };
    const medicine = await data.replica!.medicines.add(input);
    const dose = medicineOccurrences(medicine, medicineToday())[0];
    await data.replica!.medicines.take(dose);
    mockParams = { id: medicine.id, ...(doseFocused ? { dose: dose.id } : {}) };
    const screen = await openScreen(<MedicineDetail />, data);
    expect(screen.getByText(/Taken at /)).toBeTruthy();
    const confirmation = data.replica!.snapshot().doses[0];
    await fireEvent.press(screen.getByLabelText('Medicine options'));
    await fireEvent.press(screen.getByLabelText('Edit name and notes'));
    await fireEvent.press(screen.getByLabelText('Add description'));
    await fireEvent.changeText(screen.getByLabelText('Medicine description'), 'With dinner');
    await fireEvent.press(screen.getByLabelText('Save medicine'));
    await waitFor(() => expect(screen.queryByLabelText('Medicine name')).toBeNull());
    expect(data.replica!.snapshot().medicines[0]).toMatchObject({ instructions: 'With dinner', doses: input.doses });
    expect(data.replica!.snapshot().doses[0]).toEqual(confirmation);
  });
  it('pauses and resumes reminders from Medicine options', async () => {
    const { screen, data } = await openMedicine();
    await fireEvent.press(screen.getByLabelText('Medicine options'));
    await fireEvent.press(screen.getByText('Pause reminders'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].paused).toBe(true));
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.queryByLabelText(/^Take /)).toBeNull();
    await fireEvent.press(screen.getByText('Resume reminders'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].paused).toBe(false));
  });
  it('says tomorrow for a next dose on the following day, with nothing to take today', async () => {
    const today = medicineToday();
    const weekday = ((new Date(`${today}T12:00:00`).getDay() + 6) % 7) + 1;
    const tomorrow = ((weekday % 7) + 1) as Weekday;
    const { screen, data } = await openMedicine({ weekdays: [tomorrow] });
    expect(screen.getByText('Next dose tomorrow')).toBeTruthy();
    expect(screen.queryByLabelText(/^Take /)).toBeNull();
    await screen.unmount();
    const list = await openScreen(<MedicinesList />, data);
    expect(list.getByText('Next dose tomorrow')).toBeTruthy();
  });
});

describe('Medicine supply', () => {
  async function lowMedicine() {
    const data = createInMemoryTodoData();
    const medicine = await data.replica!.medicines.add(MedicineDraft.create(medicineToday()).change({ name: 'Ibuprofen' }).commit());
    await data.replica!.medicines.setSupply(medicine.id, { pillsLeft: 4, leadDays: 14 });
    return { data, medicine };
  }
  const restockTask = (data: ReturnType<typeof createInMemoryTodoData>) =>
    data.replica!.snapshot().tasks.find((task) => task.parent?.kind === 'medicine');

  it('asks how many pills were bought before completing a restock Task from Home', async () => {
    const { data } = await lowMedicine();
    const screen = await openScreen(<HomeScreen />, data);
    expect(screen.getByText('💊')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Complete "Buy Ibuprofen"'));
    expect(screen.getByText('How many pills did you get?')).toBeTruthy();
    expect(restockTask(data)?.completedAt).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('How many pills did you get?'), '60');
    await fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].supply).toMatchObject({ pillsLeft: 64, refill: 60 }));
    expect(data.replica!.snapshot().tasks.filter((task) => !task.completedAt)).toEqual([]);
    expect(defaultToastController.getSnapshot()[0]?.message).toBe('Restocked 60 pills');
  });

  it('shows the Medicine in place of the Project on a restock Task', async () => {
    const { data, medicine } = await lowMedicine();
    const screen = await openScreen(<HomeScreen />, data);
    await fireEvent.press(screen.getByLabelText('Edit "Buy Ibuprofen"'));
    expect(screen.getByText('💊 For Ibuprofen')).toBeTruthy();
    expect(screen.queryByLabelText('Set project')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Open medicine Ibuprofen'));
    expect(mockNavigate).toHaveBeenCalledWith(`/browse/medicines/${medicine.id}`);
  });

  it('changes nothing when the restock sheet is canceled', async () => {
    const { data } = await lowMedicine();
    const screen = await openScreen(<HomeScreen />, data);
    await fireEvent.press(screen.getByLabelText('Complete "Buy Ibuprofen"'));
    await fireEvent.press(screen.getByLabelText('Cancel'));
    expect(screen.queryByText('How many pills did you get?')).toBeNull();
    expect(restockTask(data)?.completedAt).toBeNull();
    expect(data.replica!.snapshot().medicines[0].supply?.pillsLeft).toBe(4);
  });

  it('counts pills and chooses when to buy more from the Medicine page', async () => {
    const data = createInMemoryTodoData();
    const medicine = await data.replica!.medicines.add(MedicineDraft.create(medicineToday()).change({ name: 'Vitamin D' }).commit());
    mockParams = { id: medicine.id };
    const screen = await openScreen(<MedicineDetail />, data);
    expect(screen.getByText('Not counted yet')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Count pills'));
    await fireEvent.changeText(screen.getByLabelText('How many pills do you have now?'), '60');
    await fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(screen.getByText('60 pills left · about 60 days')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Remind me to buy 1 week before they run out'));
    await waitFor(() => expect(data.replica!.snapshot().medicines[0].supply).toMatchObject({ pillsLeft: 60, leadDays: 7 }));
    await fireEvent.press(screen.getByLabelText('Recount'));
    await fireEvent.changeText(screen.getByLabelText('How many pills do you have now?'), '3');
    await fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(restockTask(data)).toMatchObject({ text: 'Buy Vitamin D' }));
  });
});
