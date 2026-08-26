import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';

import { ConfirmDialog } from '../confirm-dialog';

const props = {
  title: 'Discard changes?',
  message: "The changes you've made will not be saved.",
  confirmLabel: 'Discard',
  cancelLabel: 'Cancel',
};

describe('ConfirmDialog', () => {
  it('renders the title and message', async () => {
    const { getByText } = await render(
      <ConfirmDialog {...props} onConfirm={jest.fn()} onCancel={jest.fn()} />,
    );
    expect(getByText('Discard changes?')).toBeTruthy();
    expect(
      getByText("The changes you've made will not be saved."),
    ).toBeTruthy();
  });

  it('calls onConfirm when the confirm button is tapped', async () => {
    const onConfirm = jest.fn();
    const { getByLabelText } = await render(
      <ConfirmDialog {...props} onConfirm={onConfirm} onCancel={jest.fn()} />,
    );
    fireEvent.press(getByLabelText('Discard'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel on the cancel button and on the scrim', async () => {
    const onCancel = jest.fn();
    const { getByLabelText } = await render(
      <ConfirmDialog {...props} onConfirm={jest.fn()} onCancel={onCancel} />,
    );
    fireEvent.press(getByLabelText('Cancel'));
    fireEvent.press(getByLabelText('Dismiss dialog'));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
