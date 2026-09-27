import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { TodoDataContextProvider, type TodoData } from '@/lib/todo-data-context';
import { ScreenHeader } from '../screen-header';

const mockPush = jest.fn();
const mockUpdateState = { current: {
  currentlyRunning: { isEmbeddedLaunch: true, isEmergencyLaunch: false, emergencyLaunchReason: null },
  isStartupProcedureRunning: false,
  isUpdateAvailable: false,
  isUpdatePending: false,
  isChecking: false,
  isDownloading: false,
  isRestarting: false,
  restartCount: 0,
} };
const mockUser = { current: null as null | {
  imageUrl?: string;
  fullName?: string | null;
  primaryEmailAddress?: { emailAddress: string } | null;
} };

jest.mock('@clerk/expo', () => ({
  useUser: () => ({ user: mockUser.current }),
}));
jest.mock('expo-router', () => ({
  router: { push: (href: string) => mockPush(href) },
}));
jest.mock('expo-updates', () => ({
  useUpdates: () => mockUpdateState.current,
}));

function data(overrides: Partial<TodoData> = {}): TodoData {
  return {
    replica: null,
    ready: true,
    connected: false,
    sync: { phase: 'offline', lastSyncedAt: null },
    durable: true,
    error: null,
    durabilityError: null,
    recoveries: [],
    workspaceStatus: 'guest',
    signedIn: false,
    signOut: async () => {},
    discardLocalCopyAndSignOut: async () => {},
    signOutWrongAccount: async () => {},
    deleteLocalCopyAndContinue: async () => {},
    ...overrides,
  };
}

function renderHeader(value: TodoData, showSyncStatus = false) {
  return render(
    <TodoDataContextProvider value={value}>
      <ScreenHeader title="Home" showSyncStatus={showSyncStatus} />
    </TodoDataContextProvider>,
  );
}

describe('ScreenHeader', () => {
  it('opens Home sync details from the icon beside the account', async () => {
    const lastSyncedAt = '2026-09-27T11:45:00.000Z';
    const { getByLabelText, getByText, queryByLabelText } = await renderHeader(data({
      workspaceStatus: 'account',
      signedIn: true,
      connected: true,
      sync: { phase: 'synced', lastSyncedAt },
    }), true);

    const trigger = getByLabelText('Synced');
    expect(trigger.props.className).toContain('h-12 w-12');
    fireEvent.press(trigger);

    await waitFor(() => expect(getByLabelText('Sync status details')).toBeTruthy());
    expect(getByText('Last synced')).toBeTruthy();
    expect(getByText(new Date(lastSyncedAt).toLocaleString())).toBeTruthy();
    expect(getByText('Version')).toBeTruthy();

    fireEvent.press(getByLabelText('Close sync status'));
    await waitFor(() => expect(queryByLabelText('Sync status details')).toBeNull());
  });

  it('shows connecting instead of offline while Home reconnects', async () => {
    const { getByLabelText, queryByLabelText } = await renderHeader(data({
      workspaceStatus: 'account',
      signedIn: true,
      sync: { phase: 'connecting', lastSyncedAt: '2026-09-27T11:45:00.000Z' },
    }), true);

    expect(getByLabelText('Connecting')).toBeTruthy();
    expect(queryByLabelText('Offline')).toBeNull();
  });

  it('offers optional sign-in from the guest account surface', async () => {
    mockPush.mockClear();
    mockUser.current = null;
    const { getByLabelText, getByText } = await renderHeader(data());

    fireEvent.press(getByLabelText('Account'));

    await waitFor(() => expect(getByText('Saved on this device')).toBeTruthy());
    expect(getByText('Sign in to sync your tasks across devices.')).toBeTruthy();
    fireEvent.press(getByText('Sign in'));
    expect(mockPush).toHaveBeenCalledWith('/sign-in');
  });

  it('confirms removal of the device copy before signing out', async () => {
    const signOut = jest.fn(async () => {});
    mockUser.current = {
      fullName: 'Ada Lovelace',
      primaryEmailAddress: { emailAddress: 'ada@example.test' },
    };
    const { getByLabelText, getByText } = await renderHeader(data({
      workspaceStatus: 'account',
      signedIn: true,
      connected: true,
      signOut,
    }));

    fireEvent.press(getByLabelText('Account'));
    await waitFor(() => expect(getByText('ada@example.test')).toBeTruthy());
    fireEvent.press(getByText('Sign out'));
    await waitFor(() => expect(getByText('Sign out and remove this device copy?')).toBeTruthy());
    fireEvent.press(getByText('Remove copy and sign out'));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it('offers retry and explicit discard when safe sign-out fails', async () => {
    const signOut = jest.fn(async () => { throw new Error('Sync unavailable'); });
    const discard = jest.fn(async () => {});
    mockUser.current = null;
    const { getByLabelText, getByText } = await renderHeader(data({
      workspaceStatus: 'account',
      signedIn: true,
      signOut,
      discardLocalCopyAndSignOut: discard,
    }));

    fireEvent.press(getByLabelText('Account'));
    await waitFor(() => expect(getByText('Sign out')).toBeTruthy());
    fireEvent.press(getByText('Sign out'));
    await waitFor(() => expect(getByText('Remove copy and sign out')).toBeTruthy());
    fireEvent.press(getByText('Remove copy and sign out'));

    await waitFor(() => expect(getByText('Sync unavailable')).toBeTruthy());
    expect(getByText('Retry sign out')).toBeTruthy();
    fireEvent.press(getByText('Discard local copy and sign out'));
    await waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
  });
});
