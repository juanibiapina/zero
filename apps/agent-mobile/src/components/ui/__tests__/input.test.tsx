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

  it('uses the shared editor typography when requested', async () => {
    const { getByDisplayValue } = await render(
      <Input variant="editor" value="Name an outcome" onChangeText={() => {}} />,
    );
    const input = getByDisplayValue('Name an outcome');
    expect(input.props.className).toContain('text-editor');
    expect(input.props.variant).toBeUndefined();
  });

  it('calls onChangeText when edited', async () => {
    const onChangeText = jest.fn();
    const { getByPlaceholderText } = await render(
      <Input placeholder="Add a todo" onChangeText={onChangeText} />,
    );
    const input = getByPlaceholderText('Add a todo');
    expect(input.props.placeholderTextColorClassName).toBe('text-placeholder');
    fireEvent.changeText(input, 'milk');
    expect(onChangeText).toHaveBeenCalledWith('milk');
  });
});
