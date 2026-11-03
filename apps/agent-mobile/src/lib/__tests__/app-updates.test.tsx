import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { useUpdateChecksOnForeground } from '@/lib/app-updates';

const mockCheck = jest.fn<() => Promise<{ isAvailable: boolean }>>();
const mockFetch = jest.fn<() => Promise<{ isNew: boolean }>>();

jest.mock('expo-updates', () => ({
  isEnabled: true,
  checkForUpdateAsync: () => mockCheck(),
  fetchUpdateAsync: () => mockFetch(),
}));

async function foreground(state: string) {
  const listener = jest.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1] as
    | ((next: string) => void)
    | undefined;
  await act(async () => listener?.(state));
}

describe('useUpdateChecksOnForeground', () => {
  it('downloads an available update when Zero returns to the foreground', async () => {
    jest.spyOn(AppState, 'addEventListener');
    mockCheck.mockResolvedValue({ isAvailable: true });
    mockFetch.mockResolvedValue({ isNew: true });
    const hook = await renderHook(() => useUpdateChecksOnForeground());

    await foreground('background');
    expect(mockCheck).not.toHaveBeenCalled();

    await foreground('active');
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockCheck.mockResolvedValue({ isAvailable: false });
    await foreground('active');
    expect(mockCheck).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });
});
