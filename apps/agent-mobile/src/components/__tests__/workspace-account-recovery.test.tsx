import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import type { TodoData } from '@/lib/todo-data-context';
import { WorkspaceAccountRecovery } from '../workspace-account-recovery';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (href: string) => mockPush(href) },
}));

function data(overrides: Partial<TodoData> = {}): TodoData {
  return {
    replica: null,
    ready: false,
    connected: false,
    durable: true,
    error: null,
    durabilityError: null,
    recoveries: [],
    workspaceStatus: 'mismatch',
    signedIn: true,
    signOut: async () => {},
    discardLocalCopyAndSignOut: async () => {},
    signOutWrongAccount: async () => {},
    deleteLocalCopyAndContinue: async () => {},
    ...overrides,
  };
}

describe('WorkspaceAccountRecovery', () => {
  it('lets the wrong account sign out while retaining the saved tasks', async () => {
    const signOutWrongAccount = jest.fn(async () => {});
    const { getByRole, getByText } = await render(
      <WorkspaceAccountRecovery data={data({ signOutWrongAccount })} />,
    );

    expect(getByText('These tasks belong to another account')).toBeTruthy();
    fireEvent.press(getByRole('button', { name: 'Sign out of this account' }));

    await waitFor(() => expect(signOutWrongAccount).toHaveBeenCalledTimes(1));
  });

  it('requires destructive confirmation before replacing the bound local copy', async () => {
    const deleteLocalCopyAndContinue = jest.fn(async () => {});
    const { getByRole, getByText, queryByText } = await render(
      <WorkspaceAccountRecovery data={data({ deleteLocalCopyAndContinue })} />,
    );

    fireEvent.press(getByRole('button', { name: 'Delete local copy' }));
    await waitFor(() => expect(getByText('Delete this device copy?')).toBeTruthy());
    expect(deleteLocalCopyAndContinue).not.toHaveBeenCalled();
    fireEvent.press(getByRole('button', { name: 'Delete copy and continue' }));

    await waitFor(() => expect(deleteLocalCopyAndContinue).toHaveBeenCalledTimes(1));
    expect(queryByText('Delete this device copy?')).toBeNull();
  });

  it('offers sign-in from a locked workspace', async () => {
    mockPush.mockClear();
    const { getByRole, getByText } = await render(
      <WorkspaceAccountRecovery data={data({
        workspaceStatus: 'locked',
        signedIn: false,
      })} />,
    );

    expect(getByText('Sign in with the account for this device to unlock your tasks.')).toBeTruthy();
    fireEvent.press(getByRole('button', { name: 'Sign in' }));
    expect(mockPush).toHaveBeenCalledWith('/sign-in');
  });
});
