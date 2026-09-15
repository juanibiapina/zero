import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';

import SignedInLayout from '../(signed-in)/_layout';

const mockUseAuth = jest.fn();
const mockOnColdStart = jest.fn(async () => {});
const mockOnForeground = jest.fn(async () => {});
const mockCreateSync = jest.fn((_getToken: unknown) => ({
  onColdStart: mockOnColdStart,
  onForeground: mockOnForeground,
}));

jest.mock('@clerk/expo', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('../../lib/timezone-sync', () => ({
  createMobileTimezoneSync: (getToken: unknown) => mockCreateSync(getToken),
}));

jest.mock('../../components/home-app-icon-sync', () => ({
  HomeAppIconSync: () => null,
}));

const mockSetAppIcon = jest.fn<(icon: string) => boolean>();
jest.mock('../../../modules/home-app-icon', () => ({
  setHomeAppIcon: (icon: string) => mockSetAppIcon(icon),
}));

jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    const { Text } = require('react-native');
    return <Text>redirect:{href}</Text>;
  },
}));

jest.mock('expo-router/unstable-native-tabs', () => {
  const { Text } = require('react-native');
  function NativeTabs({ children }: { children?: unknown }) {
    return <Text>tabs{children}</Text>;
  }
  function Trigger({ children }: { children?: unknown }) {
    return <>{children}</>;
  }
  function TriggerIcon() {
    return null;
  }
  function TriggerLabel({ children }: { children?: unknown }) {
    return <Text>{children}</Text>;
  }
  function TriggerBadge() {
    return null;
  }
  Trigger.Icon = TriggerIcon;
  Trigger.Label = TriggerLabel;
  Trigger.Badge = TriggerBadge;
  NativeTabs.Trigger = Trigger;
  return { NativeTabs };
});

describe('SignedInLayout', () => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockSetAppIcon.mockReset();
    mockSetAppIcon.mockReturnValue(true);
    mockOnColdStart.mockClear();
    mockOnForeground.mockClear();
    mockCreateSync.mockClear();
  });

  it('shows a loading indicator until Clerk is loaded', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: false, isSignedIn: false });
    const { toJSON } = await render(<SignedInLayout />);
    expect(JSON.stringify(toJSON())).toContain('ActivityIndicator');
    expect(mockSetAppIcon).not.toHaveBeenCalled();
  });

  it('redirects to sign-in when signed out', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    const { getByText } = await render(<SignedInLayout />);
    expect(getByText('redirect:/sign-in')).toBeTruthy();
  });

  it('renders the tab bar with both sections when signed in', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true });
    const { getByText } = await render(<SignedInLayout />);
    expect(getByText(/^tabs/)).toBeTruthy();
    expect(getByText('Home')).toBeTruthy();
    expect(getByText('Upcoming')).toBeTruthy();
  });

  it('does not sync timezone while signed out', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    await render(<SignedInLayout />);
    expect(mockCreateSync).not.toHaveBeenCalled();
  });

  it('restores the three-row default launcher icon when signed out', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    await render(<SignedInLayout />);

    expect(mockSetAppIcon).toHaveBeenCalledWith('Default');
  });

  it('reconciles on cold start and on foreground when signed in', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true });
    const spy = jest.spyOn(AppState, 'addEventListener');
    await render(<SignedInLayout />);

    expect(mockOnColdStart).toHaveBeenCalledTimes(1);

    const handler = spy.mock.calls.at(-1)?.[1] as (s: string) => void;
    handler('background');
    expect(mockOnForeground).not.toHaveBeenCalled();
    handler('active');
    expect(mockOnForeground).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
