import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';

import { QuickAddBar } from '../quick-add-bar';

describe('QuickAddBar', () => {
  it('renders the input and add button', async () => {
    const { getByPlaceholderText, getByLabelText } = await render(
      <QuickAddBar value="" onChangeText={() => {}} onSubmit={() => {}} />,
    );
    expect(getByPlaceholderText('Add a todo')).toBeTruthy();
    expect(getByLabelText('Add todo')).toBeTruthy();
  });

  it('submits on the add button and on the keyboard done key', async () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByPlaceholderText } = await render(
      <QuickAddBar value="buy milk" onChangeText={() => {}} onSubmit={onSubmit} />,
    );

    fireEvent.press(getByLabelText('Add todo'));
    fireEvent(getByPlaceholderText('Add a todo'), 'submitEditing');

    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
