import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { defaultToastController } from '@zero/agent-core';

import { Toaster } from '../toaster';

// The renderer adapter's job is to paint the controller's snapshot and wire the
// action; the controller's reactivity is covered by its own agent-core tests and
// by React's useSyncExternalStore (which re-renders on device). react-test-
// renderer does not flush a synchronous store mutation done via act(), and the
// app's other useSyncExternalStore stores (e.g. refine-session) behave the same
// under jest — so these tests seed the controller BEFORE render.
describe('Toaster', () => {
  afterEach(() => defaultToastController.dismiss());

  it('renders a toast message, description and action', async () => {
    defaultToastController.show({
      message: 'Project created',
      description: 'ship the app',
      action: { label: 'View', onPress: () => {} },
      durationMs: Infinity,
    });
    const { getByText, getByLabelText } = await render(<Toaster />);
    expect(getByText('Project created')).toBeTruthy();
    expect(getByText('ship the app')).toBeTruthy();
    expect(getByLabelText('View')).toBeTruthy();
  });

  it('renders both a link and an action, and the link fires and dismisses', async () => {
    const onLink = jest.fn();
    defaultToastController.show({
      message: 'Completed',
      description: '📁 Ship the app',
      link: { label: 'Open', onPress: onLink },
      action: { label: 'Undo', onPress: () => {} },
      durationMs: Infinity,
    });
    const { getByLabelText } = await render(<Toaster />);
    expect(getByLabelText('Open')).toBeTruthy();
    expect(getByLabelText('Undo')).toBeTruthy();
    fireEvent.press(getByLabelText('Open'));
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it('fires the action onPress and dismisses on press', async () => {
    const onPress = jest.fn();
    defaultToastController.show({
      message: 'Saved',
      action: { label: 'View', onPress },
      durationMs: Infinity,
    });
    const { getByLabelText } = await render(<Toaster />);
    fireEvent.press(getByLabelText('View'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });
});
