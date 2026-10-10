import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { DeviceEventEmitter, Keyboard, Text, TextInput } from 'react-native';

import { Sheet } from '../sheet';

const keyboardEvent = {
  duration: 250,
  easing: 'keyboard',
  endCoordinates: { height: 300, screenX: 0, screenY: 500, width: 400 },
};

function emitKeyboard(name: 'keyboardDidShow' | 'keyboardDidHide') {
  DeviceEventEmitter.emit(name, keyboardEvent);
}

async function keyboardUp({ hidesAfter }: { hidesAfter: number | null }) {
  await act(async () => emitKeyboard('keyboardDidShow'));
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {
    TextInput.State.blurTextInput(TextInput.State.currentlyFocusedInput());
    if (hidesAfter != null) setTimeout(() => emitKeyboard('keyboardDidHide'), hidesAfter);
  });
}

async function openPicker(onClose = () => {}) {
  const view = await render(
    <Sheet open={false} onClose={onClose}>
      <Text>Pick a day</Text>
    </Sheet>,
  );
  await view.rerender(
    <Sheet open onClose={onClose}>
      <Text>Pick a day</Text>
    </Sheet>,
  );
  return view;
}

afterEach(async () => {
  await act(async () => emitKeyboard('keyboardDidHide'));
  TextInput.State.blurTextInput(TextInput.State.currentlyFocusedInput());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('Sheet', () => {
  it('reports a dismiss by the user once and hides its content', async () => {
    const onClose = jest.fn();
    function Owner() {
      const [open, setOpen] = useState(true);
      return (
        <Sheet open={open} onClose={() => { onClose(); setOpen(false); }}>
          <Text>Pick a day</Text>
        </Sheet>
      );
    }
    const view = await render(<Owner />);
    await fireEvent.press(view.getByLabelText('Close sheet'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.queryByText('Pick a day')).toBeNull();
  });

  it('closes without reporting a dismiss when its owner closes it', async () => {
    const onClose = jest.fn();
    const view = await render(
      <Sheet open onClose={onClose}>
        <Text>Pick a day</Text>
      </Sheet>,
    );
    await view.rerender(
      <Sheet open={false} onClose={onClose}>
        <Text>Pick a day</Text>
      </Sheet>,
    );
    expect(view.queryByText('Pick a day')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens at once when no keyboard is up', async () => {
    const view = await openPicker();
    expect(view.getByText('Pick a day')).toBeTruthy();
  });

  it('hides an open keyboard and opens once it has gone', async () => {
    jest.useFakeTimers();
    await keyboardUp({ hidesAfter: 300 });
    const view = await openPicker();
    await act(async () => { jest.advanceTimersByTime(299); });
    expect(view.queryByText('Pick a day')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(view.getByText('Pick a day')).toBeTruthy();
  });

  it('opens after 600 ms if the keyboard never reports it has gone', async () => {
    jest.useFakeTimers();
    await keyboardUp({ hidesAfter: null });
    const view = await openPicker();
    await act(async () => { jest.advanceTimersByTime(599); });
    expect(view.queryByText('Pick a day')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(view.getByText('Pick a day')).toBeTruthy();
  });

  it('shows nothing and reports no dismiss when closed while the keyboard hides', async () => {
    jest.useFakeTimers();
    await keyboardUp({ hidesAfter: 300 });
    const onClose = jest.fn();
    const view = await openPicker(onClose);
    await view.rerender(
      <Sheet open={false} onClose={onClose}>
        <Text>Pick a day</Text>
      </Sheet>,
    );
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(view.queryByText('Pick a day')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  async function focusedField(isConnected: boolean) {
    const reportError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).startsWith('dispatchCommand was called with a ref')) return;
      reportError(...args);
    });
    const field = { isConnected } as unknown as Parameters<typeof TextInput.State.focusTextInput>[0];
    await act(async () => TextInput.State.focusTextInput(field));
    return field;
  }

  async function openThenClose() {
    await keyboardUp({ hidesAfter: 300 });
    const view = await openPicker();
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(view.getByText('Pick a day')).toBeTruthy();
    await view.rerender(
      <Sheet open={false} onClose={() => {}}>
        <Text>Pick a day</Text>
      </Sheet>,
    );
  }

  it('gives the keyboard back to the field it took it from, 500 ms after closing', async () => {
    jest.useFakeTimers();
    const field = await focusedField(true);
    await openThenClose();
    await act(async () => { jest.advanceTimersByTime(499); });
    expect(TextInput.State.currentlyFocusedInput()).toBeNull();
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(TextInput.State.currentlyFocusedInput()).toBe(field);
  });

  it('leaves focus alone when the field has left the screen', async () => {
    jest.useFakeTimers();
    await focusedField(false);
    await openThenClose();
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(TextInput.State.currentlyFocusedInput()).toBeNull();
  });

  it('stays open when its own input opens the keyboard', async () => {
    const view = await openPicker();
    await act(async () => emitKeyboard('keyboardDidShow'));
    expect(view.getByText('Pick a day')).toBeTruthy();
  });
});
