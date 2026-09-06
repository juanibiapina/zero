import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  act,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from '@testing-library/react-native';
import { View } from 'react-native';

import type { Capture } from '@/lib/api';
import { resetCapturesApiForTest } from '@/lib/captures-collection';

import UpcomingScreen from '../upcoming';

// Trigger pull-to-refresh: the scroll host carries the RefreshControl element on
// its `refreshControl` prop, so invoke that control's onRefresh the way a real
// pull would.
const pullToRefresh = (screen: RenderResult) => {
  const [scroll] = screen.container.queryAll(
    (n) => n.props?.refreshControl != null,
  );
  scroll.props.refreshControl.props.onRefresh();
};

const mockGetToken = jest.fn<() => Promise<string | null>>();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

const mockUserButton = () => <View accessibilityLabel="Account" />;
jest.mock('@clerk/expo/native', () => ({
  UserButton: () => mockUserButton(),
}));

const mockFetchCaptures = jest.fn<(getToken: unknown) => Promise<Capture[]>>();
const mockProcessCapture =
  jest.fn<(getToken: unknown, id: string) => Promise<Capture>>();
jest.mock('@/lib/api', () => ({
  fetchCaptures: (getToken: unknown) => mockFetchCaptures(getToken),
  addCapture: jest.fn(),
  processCapture: (getToken: unknown, id: string) =>
    mockProcessCapture(getToken, id),
  editCapture: jest.fn(),
  rescheduleCapture: jest.fn(),
  reorderCapture: jest.fn(),
}));

const capture = (
  id: string,
  text: string,
  showUpDate: string | null = null,
): Capture => ({
  id,
  text,
  createdAt: '2023-01-01T00:00:00.000Z',
  processedAt: null,
  showUpDate,
  sortKey: null,
});

const renderScreen = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpcomingScreen />
    </QueryClientProvider>,
  );
};

describe('UpcomingScreen', () => {
  beforeEach(() => {
    resetCapturesApiForTest();
    mockProcessCapture.mockReset();
  });

  it('lists a future-dated capture and hides an undated one', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([
      capture('1', 'undated thought'),
      capture('2', 'ship the release', '2099-01-01'),
    ]);

    const { getByText, queryByText } = await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());
    // Undated captures live in the Captures tab, never Upcoming.
    expect(queryByText('undated thought')).toBeNull();
  });

  it('shows the empty message when nothing is scheduled ahead', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([capture('1', 'undated thought')]);

    const { getByText } = await renderScreen();

    await waitFor(() =>
      expect(getByText('Nothing scheduled ahead.')).toBeTruthy(),
    );
  });

  it('processes an upcoming capture, removing it', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([
      capture('2', 'ship the release', '2099-01-01'),
    ]);
    mockProcessCapture.mockImplementation(async () => {
      mockFetchCaptures.mockResolvedValue([]);
      return {
        ...capture('2', 'ship the release', '2099-01-01'),
        processedAt: '2023-01-02T00:00:00.000Z',
      };
    });

    const { getByText, getByLabelText, queryByText } = await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Process "ship the release"'));
    });

    await waitFor(() => expect(queryByText('ship the release')).toBeNull());
    expect(mockProcessCapture).toHaveBeenCalledTimes(1);
    expect(mockProcessCapture.mock.calls[0][1]).toBe('2');
  });

  it('re-pulls the captures when the list is pulled to refresh', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([
      capture('2', 'ship the release', '2099-01-01'),
    ]);

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByText('ship the release')).toBeTruthy());

    const before = mockFetchCaptures.mock.calls.length;
    await act(async () => {
      pullToRefresh(screen);
    });

    await waitFor(() =>
      expect(mockFetchCaptures.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
