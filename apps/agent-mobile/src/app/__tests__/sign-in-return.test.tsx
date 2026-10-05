import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { router, Slot, Stack } from 'expo-router';
import { act, renderRouter, screen } from 'expo-router/testing-library';
import { useEffect } from 'react';
import { Text } from 'react-native';

import SignInScreen from '../sign-in';
import SSOCallback from '../sso-callback';

jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useSSO: () => ({ startSSOFlow: jest.fn() }),
}));
jest.mock('expo-router/build/testing-library/mocks', () => ({}));
jest.mock('react-native-safe-area-context', () => jest.requireActual<typeof import('react-native-safe-area-context/jest/mock')>('react-native-safe-area-context/jest/mock').default);

const workspaceMounts = jest.fn();
function TodoGroupLayout() {
  useEffect(() => { workspaceMounts(); }, []);
  return <Slot />;
}

function renderApp(initialUrl = '/') {
  return renderRouter({
    _layout: () => <Stack screenOptions={{ headerShown: false }} />,
    '(todo)/_layout': TodoGroupLayout,
    '(todo)/index': () => <Text>Home</Text>,
    'sign-in': SignInScreen,
    'sso-callback': SSOCallback,
  }, { initialUrl });
}

describe('Returning to Home after sign-in', () => {
  beforeEach(() => { workspaceMounts.mockReset(); });

  it.each(['/sign-in', '/sso-callback'] as const)('returns from %s to the existing todo workspace', async (path) => {
    const result = renderApp();
    await result;
    expect(screen.getByText('Home')).toBeTruthy();
    await act(async () => { router.push(path); });

    expect(result.getPathname()).toBe('/');
    expect(screen.getByText('Home')).toBeTruthy();
    expect(workspaceMounts).toHaveBeenCalledTimes(1);
    expect(router.canGoBack()).toBe(false);
  });

  it('opens Home when the OAuth callback starts the app', async () => {
    const result = renderApp('/sso-callback');
    await result;

    expect(result.getPathname()).toBe('/');
    expect(screen.getByText('Home')).toBeTruthy();
    expect(workspaceMounts).toHaveBeenCalledTimes(1);
  });
});
