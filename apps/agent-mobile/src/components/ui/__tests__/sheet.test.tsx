import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { BackHandler, Keyboard, Text, TextInput } from 'react-native';

import { Sheet } from '../sheet';

function captureBack() {
  const listeners: Parameters<typeof BackHandler.addEventListener>[1][] = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    listeners.push(handler);
    return { remove: () => { listeners.splice(listeners.indexOf(handler), 1); } };
  });
  return async () => {
    let handled = false;
    await act(async () => {
      handled = [...listeners].reverse().some((listener) => listener({} as never) === true);
    });
    return handled;
  };
}

function Owner({ onClose = () => {}, initial = true, answer }: {
  onClose?: () => void;
  initial?: boolean;
  answer?: false;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <>
      <Text onPress={() => setOpen(true)}>Open</Text>
      <Text onPress={() => setOpen(false)}>Owner close</Text>
      <Sheet
        open={open}
        contextBridge={null}
        onClose={() => {
          onClose();
          if (answer === false) return false;
          setOpen(false);
        }}
      >
        <Text>Pick a day</Text>
      </Sheet>
    </>
  );
}

afterEach(() => {
  TextInput.State.blurTextInput(TextInput.State.currentlyFocusedInput());
  jest.restoreAllMocks();
});

describe('Sheet', () => {
  it('reports a dismissal by the user once and hides its content', async () => {
    const onClose = jest.fn<() => void>();
    const view = await render(<Owner onClose={onClose} />);
    expect(view.getByText('Pick a day')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('Close sheet'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.queryByText('Pick a day')).toBeNull();
  });

  it('closes without reporting a dismissal when its owner closes it', async () => {
    const onClose = jest.fn<() => void>();
    const view = await render(<Owner onClose={onClose} />);
    await fireEvent.press(view.getByText('Owner close'));
    expect(view.queryByText('Pick a day')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('comes back when its owner answers a dismissal with false', async () => {
    const view = await render(<Owner answer={false} />);
    await fireEvent.press(view.getByLabelText('Close sheet'));
    expect(view.getByText('Pick a day')).toBeTruthy();
  });

  it('opens again after the owner closed it', async () => {
    const view = await render(<Owner initial={false} />);
    expect(view.queryByText('Pick a day')).toBeNull();
    await fireEvent.press(view.getByText('Open'));
    expect(view.getByText('Pick a day')).toBeTruthy();
  });

  it('closes only the top sheet on Back, then the one below', async () => {
    const pressBack = captureBack();
    const closed: string[] = [];
    function Stack() {
      const [editor, setEditor] = useState(true);
      const [picker, setPicker] = useState(false);
      return (
        <>
          <Sheet open={editor} contextBridge={null} onClose={() => { closed.push('editor'); setEditor(false); }}>
            <Text onPress={() => setPicker(true)}>Editor</Text>
          </Sheet>
          <Sheet open={picker} contextBridge={null} onClose={() => { closed.push('picker'); setPicker(false); }}>
            <Text>Picker</Text>
          </Sheet>
        </>
      );
    }
    const view = await render(<Stack />);
    await fireEvent.press(view.getByText('Editor'));
    expect(await pressBack()).toBe(true);
    expect(closed).toEqual(['picker']);
    expect(view.getByText('Editor')).toBeTruthy();
    expect(await pressBack()).toBe(true);
    expect(closed).toEqual(['picker', 'editor']);
    expect(await pressBack()).toBe(false);
  });

  it('leaves Back alone while closed', async () => {
    const pressBack = captureBack();
    await render(<Owner initial={false} />);
    expect(await pressBack()).toBe(false);
  });

  async function focusedField(isConnected: boolean) {
    const reportError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).startsWith('dispatchCommand was called with a ref')) return;
      reportError(...args);
    });
    const field = { isConnected } as unknown as Parameters<typeof TextInput.State.focusTextInput>[0];
    await act(async () => TextInput.State.focusTextInput(field));
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {
      TextInput.State.blurTextInput(TextInput.State.currentlyFocusedInput());
    });
    return { field, dismiss };
  }

  it('hides the keyboard when it opens and gives it back to the field when it closes', async () => {
    const { field, dismiss } = await focusedField(true);
    const view = await render(<Owner initial={false} />);
    await fireEvent.press(view.getByText('Open'));
    expect(dismiss).toHaveBeenCalled();
    expect(TextInput.State.currentlyFocusedInput()).toBeNull();
    await fireEvent.press(view.getByLabelText('Close sheet'));
    expect(TextInput.State.currentlyFocusedInput()).toBe(field);
  });

  it('leaves focus alone when the field has left the screen', async () => {
    await focusedField(false);
    const view = await render(<Owner initial={false} />);
    await fireEvent.press(view.getByText('Open'));
    await fireEvent.press(view.getByText('Owner close'));
    expect(TextInput.State.currentlyFocusedInput()).toBeNull();
  });
});
