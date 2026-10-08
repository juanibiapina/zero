import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MedicineDraft, medicineToday } from '@zero/agent-core';
import { router, Stack } from 'expo-router';
import { act, fireEvent, renderRouter } from 'expo-router/testing-library';

import BrowseLayout from '@/app/(todo)/browse/_layout';
import BrowseScreen from '@/app/(todo)/browse/index';
import { createInMemoryTodoData, InMemoryTodoDataProvider } from '@/testing/in-memory-todo-data';
import { MedicineDetail, MedicinesList } from '../medicines';

jest.mock('@clerk/expo', () => ({ useUser: () => ({ user: null }) }));
jest.mock('expo-router/build/testing-library/mocks', () => ({}));
jest.mock('react-native-safe-area-context', () => jest.requireActual<typeof import('react-native-safe-area-context/jest/mock')>('react-native-safe-area-context/jest/mock').default);

afterEach(() => { jest.useRealTimers(); });

async function openRoutes(initialUrl: (id: string, slot: string) => string = () => '/browse') {
  const data = createInMemoryTodoData();
  const medicine = await data.replica!.medicines.add(MedicineDraft.create(medicineToday()).change({ name: 'Vitamin D' }).commit());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = renderRouter({
    _layout: () => <QueryClientProvider client={client}><InMemoryTodoDataProvider data={data}><Stack screenOptions={{ headerShown: false }} /></InMemoryTodoDataProvider></QueryClientProvider>,
    'browse/_layout': BrowseLayout,
    'browse/index': BrowseScreen,
    'browse/medicines/index': MedicinesList,
    'browse/medicines/[id]': MedicineDetail,
  }, { initialUrl: initialUrl(medicine.id, medicine.doses[0].id) });
  return { screen: await result, result, medicine };
}

describe('Medicine return navigation', () => {
  it('returns from a medicine to its list and then to Browse', async () => {
    const { screen, result, medicine } = await openRoutes();
    await fireEvent.press(screen.getByLabelText('Medicines'));
    await fireEvent.press(screen.getByLabelText('Open Vitamin D'));
    expect(result.getPathname()).toBe(`/browse/medicines/${medicine.id}`);
    await fireEvent.press(screen.getByLabelText('Back to medicines'));
    expect(result.getPathname()).toBe('/browse/medicines');
    await fireEvent.press(screen.getByLabelText('Back to Browse'));
    expect(result.getPathname()).toBe('/browse');
    expect(screen.getByLabelText('Upcoming')).toBeTruthy();
  });

  it('leaves one Medicines list so system Back returns to Browse', async () => {
    const { screen, result } = await openRoutes();
    await fireEvent.press(screen.getByLabelText('Medicines'));
    await fireEvent.press(screen.getByLabelText('Open Vitamin D'));
    await fireEvent.press(screen.getByLabelText('Back to medicines'));
    await act(async () => { router.back(); });
    expect(result.getPathname()).toBe('/browse');
  });

  it('opens the dose a reminder links to', async () => {
    const { screen } = await openRoutes((id, slot) => `/browse/medicines/${id}?slot=${slot}&date=${medicineToday()}`);
    expect(screen.getByLabelText('Take 20:00 dose, 1 pill').props.accessibilityState.selected).toBe(true);
    expect(screen.queryByText('This dose is no longer available.')).toBeNull();
  });

  it('returns a directly opened medicine to Medicines and then Browse', async () => {
    const { screen, result } = await openRoutes((id) => `/browse/medicines/${id}`);
    await fireEvent.press(screen.getByLabelText('Back to medicines'));
    expect(result.getPathname()).toBe('/browse/medicines');
    expect(screen.getByLabelText('Open Vitamin D')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Back to Browse'));
    expect(result.getPathname()).toBe('/browse');
    expect(screen.getByLabelText('Upcoming')).toBeTruthy();
  });
});
