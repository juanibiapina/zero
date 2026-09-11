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
const mockEditCapture =
  jest.fn<(getToken: unknown, id: string, text: string) => Promise<Capture>>();
const mockRescheduleCapture =
  jest.fn<
    (getToken: unknown, id: string, date: string | null) => Promise<Capture>
  >();
jest.mock('@/lib/api', () => ({
  fetchCaptures: (getToken: unknown) => mockFetchCaptures(getToken),
  addCapture: jest.fn(),
  processCapture: (getToken: unknown, id: string) =>
    mockProcessCapture(getToken, id),
  editCapture: (getToken: unknown, id: string, text: string) =>
    mockEditCapture(getToken, id, text),
  rescheduleCapture: (getToken: unknown, id: string, date: string | null) =>
    mockRescheduleCapture(getToken, id, date),
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
    mockEditCapture.mockReset();
    mockRescheduleCapture.mockReset();
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

  it('opens the capture detail editor and edits the title', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([
      capture('2', 'ship the release', '2099-01-01'),
    ]);
    mockEditCapture.mockImplementation(async (_g, id, text) => {
      const edited = capture(id, text, '2099-01-01');
      mockFetchCaptures.mockResolvedValue([edited]);
      return edited;
    });

    const { getByText, getByLabelText, getByDisplayValue } = await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByLabelText('Edit "ship the release"'));
    });

    // Same sheet as Home: the editable title, not an inline row input.
    const input = getByDisplayValue('ship the release');
    await act(async () => {
      fireEvent.changeText(input, 'ship the big release');
    });
    // The keyboard done key (onSubmitEditing) saves and closes; submit in its own
    // act so the edited draft is committed, not the stale one.
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('ship the big release')).toBeTruthy());
    expect(mockEditCapture).toHaveBeenCalledTimes(1);
    expect(mockEditCapture.mock.calls[0][1]).toBe('2');
    expect(mockEditCapture.mock.calls[0][2]).toBe('ship the big release');
  });

  it('reschedules an upcoming capture from the scheduler', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchCaptures.mockResolvedValue([
      capture('2', 'ship the release', '2099-01-01'),
    ]);
    mockRescheduleCapture.mockResolvedValue(
      capture('2', 'ship the release', '2099-01-02'),
    );

    const { getByText, getByLabelText } = await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByLabelText('Edit "ship the release"'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Set schedule'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Tomorrow'));
    });

    await waitFor(() => expect(mockRescheduleCapture).toHaveBeenCalledTimes(1));
    expect(mockRescheduleCapture.mock.calls[0][1]).toBe('2');
    expect(mockRescheduleCapture.mock.calls[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('completes a capture from the detail round check', async () => {
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

    const { getByText, getByLabelText, queryByText, queryByLabelText } =
      await renderScreen();

    await waitFor(() => expect(getByText('ship the release')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByLabelText('Edit "ship the release"'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Complete capture'));
    });

    await waitFor(() => expect(queryByLabelText('sheet')).toBeNull());
    await waitFor(() => expect(queryByText('ship the release')).toBeNull());
    expect(mockProcessCapture).toHaveBeenCalledTimes(1);
    expect(mockProcessCapture.mock.calls[0][1]).toBe('2');
  });
});
