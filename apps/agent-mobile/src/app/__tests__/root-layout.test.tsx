import { expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import { defaultToastController } from '@zero/agent-core';
import { tokenCache } from '@clerk/expo/token-cache';
import { resourceCache } from '@clerk/expo/resource-cache';
import RootLayout from '../_layout';

const mockProvider = jest.fn();
jest.mock('@clerk/expo', () => ({
  ClerkProvider: (props: unknown) => { mockProvider(props); return null; },
}));
jest.mock('expo-router', () => ({ Stack: () => null, usePathname: () => '/' }));
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

it('clears existing feedback when a content touch starts', async () => {
  defaultToastController.show({ message: 'Completed', durationMs: Infinity });
  const screen = await render(<RootLayout />);
  expect(defaultToastController.getSnapshot()).toHaveLength(1);
  const root = screen.container.queryAll((node) => node.props?.onTouchStart != null)
    .find((node) => node.props.style?.flex === 1);
  expect(root).toBeDefined();
  await act(async () => fireEvent(root!, 'touchStart'));
  expect(defaultToastController.getSnapshot()).toHaveLength(0);
  await screen.unmount();
});

it('leaves Undo available when the user touches the toast itself', async () => {
  const undo = jest.fn();
  defaultToastController.show({ message: 'Completed', action: { label: 'Undo', onPress: undo }, durationMs: Infinity });
  const screen = await render(<RootLayout />);
  const stopPropagation = jest.fn();
  fireEvent(screen.getByText('Completed'), 'touchStart', { stopPropagation });
  expect(stopPropagation).toHaveBeenCalled();
  expect(defaultToastController.getSnapshot()).toHaveLength(1);
  fireEvent.press(screen.getByLabelText('Undo'));
  expect(undo).toHaveBeenCalledTimes(1);
  expect(defaultToastController.getSnapshot()).toHaveLength(0);
  await screen.unmount();
});
