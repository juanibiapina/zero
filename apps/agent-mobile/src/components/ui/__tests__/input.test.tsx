import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';

import { Input } from '../input';

describe('Input', () => {
  it('renders its current value', async () => {
    const { getByDisplayValue } = await render(
      <Input value="hello" onChangeText={() => {}} />,
    );
    expect(getByDisplayValue('hello')).toBeTruthy();
  });

  it('calls onChangeText when edited', async () => {
    const onChangeText = jest.fn();
    const { getByPlaceholderText } = await render(
      <Input placeholder="Add a todo" onChangeText={onChangeText} />,
    );
    fireEvent.changeText(getByPlaceholderText('Add a todo'), 'milk');
    expect(onChangeText).toHaveBeenCalledWith('milk');
  });
});
