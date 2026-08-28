import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import type { Capture } from '@/lib/api';

import HomeScreen from '../index';

const mockGetToken = jest.fn<() => Promise<string | null>>();
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

// The native Clerk button renders a platform view via requireNativeView, which
// is unavailable under jest. Stub it with a queryable element. The component is
// defined at module scope (mock-prefixed) so the jest.mock factory needs no
// createElement/JSX, which NativeWind's babel transform would reject inside it.
const mockUserButton = () => <View accessibilityLabel="Account" />;
jest.mock('@clerk/expo/native', () => ({
  UserButton: () => mockUserButton(),
}));

const mockFetchInbox = jest.fn<(getToken: unknown) => Promise<Capture[]>>();
const mockAddCapture =
  jest.fn<
    (
      getToken: unknown,
      capture: { id: string; text: string },
    ) => Promise<Capture>
  >();
const mockProcessCapture =
  jest.fn<(getToken: unknown, id: string) => Promise<Capture>>();
jest.mock('@/lib/api', () => ({
  fetchInbox: (getToken: unknown) => mockFetchInbox(getToken),
  addCapture: (getToken: unknown, capture: { id: string; text: string }) =>
    mockAddCapture(getToken, capture),
  processCapture: (getToken: unknown, id: string) =>
    mockProcessCapture(getToken, id),
}));

const capture = (id: string, text: string): Capture => ({
  id,
  text,
  createdAt: '2023-01-01T00:00:00.000Z',
  processedAt: null,
});

// Render the screen inside a fresh QueryClient with retries off, so a rejected
// query fails fast and deterministically instead of retrying with backoff.
const renderScreen = () => {
  const client = new QueryClient({
    defaultOptions: {
      // retry off = deterministic failures; gcTime 0 = no lingering gc timer
      // that would keep jest from exiting.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <HomeScreen />
    </QueryClientProvider>,
  );
};

describe('HomeScreen', () => {
  it('shows a loading state until the first fetch settles', async () => {
    mockGetToken.mockResolvedValue('tok');
    let resolveFetch!: (captures: Capture[]) => void;
    mockFetchInbox.mockReturnValue(
      new Promise<Capture[]>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { getByText, queryByText } = await renderScreen();

    // Fetch is still pending: loading shown, empty message NOT shown.
    expect(getByText('Loading your inbox…')).toBeTruthy();
    expect(queryByText('Your inbox is empty. Capture something.')).toBeNull();

    await act(async () => {
      resolveFetch([]);
    });

    await waitFor(() =>
      expect(
        getByText('Your inbox is empty. Capture something.'),
      ).toBeTruthy(),
    );
    expect(queryByText('Loading your inbox…')).toBeNull();
  });

  it('shows the account button instead of a sign-out button', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([]);

    const { getByLabelText, queryByText } = await renderScreen();

    expect(getByLabelText('Account')).toBeTruthy();
    expect(queryByText('Sign out')).toBeNull();
  });

  it('surfaces a load error when there is nothing to show', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockRejectedValue(
      new Error('java.net.UnknownHostException'),
    );

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText(/UnknownHostException/)).toBeTruthy());
  });

  it('shows the fetched captures', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([capture('1', 'buy milk')]);

    const { getByText } = await renderScreen();

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());
  });

  it('processes a capture, removing it from the Inbox', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([capture('1', 'buy milk')]);
    // The collection refetches after the write; once processed the open Inbox is
    // empty, so the server (mock) then returns [].
    mockProcessCapture.mockImplementation(async () => {
      mockFetchInbox.mockResolvedValue([]);
      return { ...capture('1', 'buy milk'), processedAt: '2023-01-02T00:00:00.000Z' };
    });

    const { getByText, getByLabelText, queryByText } = await renderScreen();

    await waitFor(() => expect(getByText('buy milk')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByLabelText('Process "buy milk"'));
    });

    await waitFor(() => expect(queryByText('buy milk')).toBeNull());
    expect(mockProcessCapture).toHaveBeenCalledTimes(1);
    expect(mockProcessCapture.mock.calls[0][1]).toBe('1');
  });

  it('opens the quick-add input only after tapping the add button', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([]);

    const { getByLabelText, queryByPlaceholderText } = await renderScreen();

    await waitFor(() =>
      expect(queryByPlaceholderText('Capture a thought')).toBeNull(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });

    expect(queryByPlaceholderText('Capture a thought')).toBeTruthy();
  });

  it('captures typed text and keeps the input open and cleared for the next one', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([]);
    // The collection refetches after the write; the server (mock) then returns
    // the newly added capture so it survives reconciliation.
    mockAddCapture.mockImplementation(async () => {
      const added = capture('2', 'call mom');
      mockFetchInbox.mockResolvedValue([added]);
      return added;
    });

    const { getByText, getByLabelText, getByPlaceholderText } =
      await renderScreen();

    // Let the initial (empty) load settle before typing, else it can clobber
    // the just-added item.
    await waitFor(() =>
      expect(
        getByText('Your inbox is empty. Capture something.'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });

    const input = getByPlaceholderText('Capture a thought');
    await act(async () => {
      fireEvent.changeText(input, 'call mom');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    await waitFor(() => expect(getByText('call mom')).toBeTruthy());
    expect(mockAddCapture).toHaveBeenCalledTimes(1);
    expect(mockAddCapture.mock.calls[0][1].text).toBe('call mom');

    // The quick-add input stays open and cleared for rapid capture.
    const reopened = getByPlaceholderText('Capture a thought');
    expect(reopened.props.value).toBe('');
  });

  it('confirms before discarding unsaved quick-add text', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([]);

    const { getByLabelText, getByText, getByPlaceholderText, queryByText } =
      await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Your inbox is empty. Capture something.'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    const input = getByPlaceholderText('Capture a thought');
    await act(async () => {
      fireEvent.changeText(input, 'buy milk');
    });

    // Tapping the backdrop with unsaved text opens the confirm dialog and does
    // NOT clear/close the bar.
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });
    expect(getByText('Discard changes?')).toBeTruthy();
    expect(getByPlaceholderText('Capture a thought').props.value).toBe(
      'buy milk',
    );

    // Cancel keeps editing: dialog gone, text preserved.
    await act(async () => {
      fireEvent.press(getByLabelText('Cancel'));
    });
    expect(queryByText('Discard changes?')).toBeNull();
    expect(getByPlaceholderText('Capture a thought').props.value).toBe(
      'buy milk',
    );
  });

  it('discards the quick-add text when confirming', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([]);

    const {
      getByLabelText,
      getByText,
      getByPlaceholderText,
      queryByPlaceholderText,
    } = await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Your inbox is empty. Capture something.'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('Capture a thought'), 'buy milk');
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Discard'));
    });

    expect(queryByPlaceholderText('Capture a thought')).toBeNull();
  });

  it('closes the empty quick-add when the keyboard hides (Android back)', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([]);

    const {
      getByLabelText,
      getByText,
      getByPlaceholderText,
      queryByPlaceholderText,
    } = await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Your inbox is empty. Capture something.'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    expect(getByPlaceholderText('Capture a thought')).toBeTruthy();

    // Android's first Back only hides the keyboard; the empty bar must close.
    await act(async () => {
      (
        globalThis as { __emitKeyboardEvent?: (name: string) => void }
      ).__emitKeyboardEvent?.('keyboardDidHide');
    });

    expect(queryByPlaceholderText('Capture a thought')).toBeNull();
  });

  it('confirms instead of closing when the keyboard hides with unsaved text', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([]);

    const { getByLabelText, getByText, getByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Your inbox is empty. Capture something.'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('Capture a thought'), 'buy milk');
    });

    await act(async () => {
      (
        globalThis as { __emitKeyboardEvent?: (name: string) => void }
      ).__emitKeyboardEvent?.('keyboardDidHide');
    });

    // Unsaved text: the dialog appears, the bar stays open.
    expect(getByText('Discard changes?')).toBeTruthy();
    expect(getByPlaceholderText('Capture a thought').props.value).toBe(
      'buy milk',
    );
  });

  it('closes the quick-add silently when it is empty', async () => {
    mockGetToken.mockResolvedValue('tok');
    mockFetchInbox.mockResolvedValue([]);

    const { getByLabelText, getByText, queryByText, queryByPlaceholderText } =
      await renderScreen();

    await waitFor(() =>
      expect(
        getByText('Your inbox is empty. Capture something.'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Capture'));
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Dismiss quick add'));
    });

    expect(queryByText('Discard changes?')).toBeNull();
    expect(queryByPlaceholderText('Capture a thought')).toBeNull();
  });
});
