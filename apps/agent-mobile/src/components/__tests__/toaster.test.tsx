import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo, AppState, Platform } from 'react-native';
import { defaultToastController } from '@zero/agent-core';

import { Toaster } from '../toaster';

let mockPathname = '/';
jest.mock('expo-router', () => ({ usePathname: () => mockPathname }));

// The renderer adapter's job is to paint the controller's snapshot and wire the
// action; the controller's reactivity is covered by its own agent-core tests and
// by React's useSyncExternalStore (which re-renders on device). react-test-
// renderer does not flush a synchronous store mutation done via act(), and the
// app's other useSyncExternalStore stores (e.g. refine-session) behave the same
// under jest — so these tests seed the controller BEFORE render.
describe('Toaster', () => {
  afterEach(async () => {
    await act(async () => defaultToastController.dismiss());
    jest.restoreAllMocks();
    jest.useRealTimers();
    mockPathname = '/';
  });

  it('expires Undo after four seconds when Android recommends no extension', async () => {
    jest.useFakeTimers();
    const oldPlatform = Platform.OS;
    Platform.OS = 'android';
    jest.spyOn(AccessibilityInfo, 'getRecommendedTimeoutMillis').mockResolvedValue(4000);
    defaultToastController.show({ message: 'Completed', action: { label: 'Undo', onPress: () => {} } });
    const screen = await render(<Toaster />);
    await act(async () => {});
    expect(AccessibilityInfo.getRecommendedTimeoutMillis).toHaveBeenCalledWith(4000);
    await act(async () => jest.advanceTimersByTime(3999));
    expect(defaultToastController.getSnapshot()).toHaveLength(1);
    await act(async () => jest.advanceTimersByTime(1));
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
    await screen.unmount();
    Platform.OS = oldPlatform;
  });

  it('honors a longer Android accessibility timeout', async () => {
    jest.useFakeTimers();
    const oldPlatform = Platform.OS;
    Platform.OS = 'android';
    jest.spyOn(AccessibilityInfo, 'getRecommendedTimeoutMillis').mockResolvedValue(12000);
    defaultToastController.show({ message: 'Completed', action: { label: 'Undo', onPress: () => {} } });
    const screen = await render(<Toaster />);
    await act(async () => {});
    await act(async () => jest.advanceTimersByTime(11999));
    expect(defaultToastController.getSnapshot()).toHaveLength(1);
    await act(async () => jest.advanceTimersByTime(1));
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
    await screen.unmount();
    Platform.OS = oldPlatform;
  });

  it.each(['inactive', 'background'] as const)('clears even a sticky toast on %s and does not restore it', async (state) => {
    jest.useFakeTimers();
    let change: (state: 'active' | 'background' | 'inactive') => void = () => {};
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      change = listener;
      return { remove: () => {} };
    });
    defaultToastController.show({ message: 'Could not delete project', durationMs: Infinity });
    const screen = await render(<Toaster />);
    await act(async () => change(state));
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
    await act(async () => {
      change('active');
      jest.advanceTimersByTime(60000);
    });
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
    await screen.unmount();
  });

  it('keeps a toast on initial render but clears it when the route changes', async () => {
    defaultToastController.show({ message: 'Completed', durationMs: Infinity });
    const screen = await render(<Toaster />);
    expect(defaultToastController.getSnapshot()).toHaveLength(1);
    mockPathname = '/upcoming';
    await screen.rerender(<Toaster />);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it('does not show feedback raised while the app is backgrounded', async () => {
    let change: (state: 'active' | 'background') => void = () => {};
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      change = listener;
      return { remove: () => {} };
    });
    const screen = await render(<Toaster />);
    await act(async () => change('background'));
    await act(async () => defaultToastController.show({ message: 'Late result' }));
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
    await act(async () => change('active'));
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
    await screen.unmount();
  });

  it('does not revive a dismissed toast after a slow Android recommendation', async () => {
    jest.useFakeTimers();
    const oldPlatform = Platform.OS;
    Platform.OS = 'android';
    let recommend: (ms: number) => void = () => {};
    jest.spyOn(AccessibilityInfo, 'getRecommendedTimeoutMillis').mockImplementation(
      () => new Promise<number>((resolve) => { recommend = resolve; }),
    );
    defaultToastController.show({ id: 'undo', message: 'Completed', action: { label: 'Undo', onPress: () => {} } });
    const screen = await render(<Toaster />);
    await act(async () => defaultToastController.dismiss());
    await act(async () => recommend(12000));
    await act(async () => jest.advanceTimersByTime(12000));
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
    await screen.unmount();
    Platform.OS = oldPlatform;
  });

  it('dismisses a toast after a committed horizontal swipe', async () => {
    jest.useFakeTimers();
    defaultToastController.show({ message: 'Completed', durationMs: Infinity });
    (global as { __lastPanGesture?: unknown }).__lastPanGesture = undefined;
    await render(<Toaster />);

    const pan = (global as unknown as {
      __lastPanGesture: {
        __onStart: () => void;
        __onUpdate: (event: { translationX: number }) => void;
        __onEnd: (event: { velocityX: number }) => void;
      };
    }).__lastPanGesture;

    expect(pan).toBeDefined();
    await act(async () => {
      pan.__onStart();
      pan.__onUpdate({ translationX: 160 });
      pan.__onEnd({ velocityX: 0 });
      jest.runOnlyPendingTimers();
    });

    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it('renders the project icon and name inline with a View action', async () => {
    defaultToastController.show({
      message: 'Project created',
      description: '📁 ship the app',
      action: { label: 'View', onPress: () => {} },
      durationMs: Infinity,
    });
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const { getByText, getByLabelText } = await render(<Toaster />);
    expect(announce).toHaveBeenCalledWith('Project created. 📁 ship the app');
    expect(getByText('Project created')).toBeTruthy();
    expect(getByText(' · 📁 ship the app')).toBeTruthy();
    expect(getByLabelText('View')).toBeTruthy();
  });

  it('keeps the project icon and both completion actions on the same row', async () => {
    const openProject = jest.fn();
    const addWaiting = jest.fn();
    defaultToastController.show({
      message: 'Completed',
      description: '🎓 Diploma',
      descriptionAction: { accessibilityLabel: 'Open project Diploma', onPress: openProject },
      action: { label: 'Undo', onPress: () => {} },
      secondaryAction: {
        label: 'Waiting…',
        accessibilityLabel: 'Add waiting condition to Diploma',
        onPress: addWaiting,
      },
      durationMs: Infinity,
    });
    const screen = await render(<Toaster />);
    expect(screen.getByText(' · 🎓 Diploma')).toBeTruthy();
    expect(screen.getByLabelText('Undo')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Add waiting condition to Diploma'));
    expect(addWaiting).toHaveBeenCalledTimes(1);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
    expect(openProject).not.toHaveBeenCalled();
  });

  it('opens the icon-labelled project directly from the compact result', async () => {
    const openProject = jest.fn();
    defaultToastController.show({
      message: 'Completed',
      description: '🎓 Diploma',
      descriptionAction: { accessibilityLabel: 'Open project Diploma', onPress: openProject },
      durationMs: Infinity,
    });
    const { getByLabelText } = await render(<Toaster />);
    fireEvent.press(getByLabelText('Open project Diploma'));
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it('keeps a sticky failure readable and dismissible', async () => {
    defaultToastController.show({
      message: 'Project deleted · Pull to refresh',
      durationMs: Infinity,
      action: { label: 'Dismiss', onPress: () => {} },
    });
    const { getByText, getByLabelText } = await render(<Toaster />);
    expect(getByText('Project deleted · Pull to refresh')).toBeTruthy();
    fireEvent.press(getByLabelText('Dismiss'));
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
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
