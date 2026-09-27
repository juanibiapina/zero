import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, Platform, Text } from 'react-native';

import TodoLayout from '../(signed-in)/_layout';

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

jest.mock('../../lib/todo-data-context', () => ({
  TodoDataProvider: ({ children }: { children: unknown }) => children,
}));

jest.mock('../../components/home-app-icon-sync', () => ({
  HomeAppIconSync: () => null,
}));

const mockSetAppIcon = jest.fn<(icon: string) => boolean>();
jest.mock('../../../modules/home-app-icon', () => ({
  setHomeAppIcon: (icon: string) => mockSetAppIcon(icon),
}));

function mockTrigger({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
function MockTriggerIcon() { return null; }
function MockTriggerLabel({ children }: { children?: ReactNode }) {
  return <Text>{children}</Text>;
}
function MockTriggerBadge() { return null; }
mockTrigger.Icon = MockTriggerIcon;
mockTrigger.Label = MockTriggerLabel;
mockTrigger.Badge = MockTriggerBadge;
function mockNativeTabs({ children }: { children?: ReactNode }) {
  return <Text>tabs{children}</Text>;
}
mockNativeTabs.Trigger = mockTrigger;
jest.mock('expo-router/unstable-native-tabs', () => ({ NativeTabs: mockNativeTabs }));

describe('TodoLayout', () => {
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
    const { toJSON } = await render(<TodoLayout />);
    expect(JSON.stringify(toJSON())).toContain('ActivityIndicator');
    expect(mockSetAppIcon).not.toHaveBeenCalled();
  });

  it('opens the todo tabs when signed out', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    const { getByText, toJSON } = await render(<TodoLayout />);
    expect(getByText(/^tabs/)).toBeTruthy();
    expect(JSON.stringify(toJSON())).toMatch(/Home.*Projects.*Browse/);
  });

  it('shows Home, Projects, and Browse in that order without an Upcoming tab', async () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      userId: 'user-test',
      getToken: async () => null,
    });
    const { getByText, queryByText, toJSON } = await render(<TodoLayout />);
    expect(getByText(/^tabs/)).toBeTruthy();
    expect(JSON.stringify(toJSON())).toMatch(/Home.*Projects.*Browse/);
    expect(queryByText('Upcoming')).toBeNull();
  });

  it('does not sync timezone while signed out', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    await render(<TodoLayout />);
    expect(mockCreateSync).not.toHaveBeenCalled();
  });

  it('restores the three-row default launcher icon when signed out', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    await render(<TodoLayout />);

    expect(mockSetAppIcon).toHaveBeenCalledWith('Default');
  });

  it('reconciles on cold start and on foreground when signed in', async () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      userId: 'user-test',
      getToken: async () => null,
    });
    const spy = jest.spyOn(AppState, 'addEventListener');
    await render(<TodoLayout />);

    expect(mockOnColdStart).toHaveBeenCalledTimes(1);

    const handler = spy.mock.calls.at(-1)?.[1] as (s: string) => void;
    handler('background');
    expect(mockOnForeground).not.toHaveBeenCalled();
    handler('active');
    expect(mockOnForeground).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
