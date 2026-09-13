import { expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import { tokenCache } from '@clerk/expo/token-cache';
import { resourceCache } from '@clerk/expo/resource-cache';
import RootLayout from '../_layout';

const mockProvider = jest.fn();
jest.mock('@clerk/expo', () => ({
  ClerkProvider: (props: unknown) => { mockProvider(props); return null; },
}));
jest.mock('expo-router', () => ({ Stack: () => null }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('@/lib/env', () => ({ CLERK_PUBLISHABLE_KEY: 'pk_test_example' }));
jest.mock('../../../global.css', () => ({}));

it('enables Clerk token and offline-resource caches', async () => {
  await render(<RootLayout />);
  expect(mockProvider).toHaveBeenCalledWith(expect.objectContaining({
    publishableKey: 'pk_test_example', tokenCache,
    __experimental_resourceCache: resourceCache,
  }));
});
