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

  it('keeps typed text while the owner has not passed it back yet', async () => {
    const view = await render(<Input value="Hello world" onChangeText={() => {}} />);

    await fireEvent.changeText(view.getByDisplayValue('Hello world'), 'Hello wrld');
    expect(view.getByDisplayValue('Hello wrld')).toBeTruthy();

    await view.rerender(<Input value="Hello wrld" onChangeText={() => {}} />);
    expect(view.getByDisplayValue('Hello wrld')).toBeTruthy();
  });

  it('shows text the owner changes', async () => {
    const view = await render(<Input value="Buy milk tomorrow" onChangeText={() => {}} />);

    await fireEvent.changeText(view.getByDisplayValue('Buy milk tomorrow'), 'Buy milk tomorrow!');
    await view.rerender(<Input value="Buy milk" onChangeText={() => {}} />);

    expect(view.getByDisplayValue('Buy milk')).toBeTruthy();
  });

  it('shows only the parser-consumed text as an inline highlight', async () => {
    const view = await render(
      <Input
        accessibilityLabel="Add a task"
        value="Stand up every day"
        highlights={[{ start: 9, end: 18, text: 'every day' }]}
        onChangeText={() => {}}
      />,
    );

    expect(view.getByDisplayValue('Stand up every day')).toBeTruthy();
    const highlight = view.getByTestId('schedule-highlight', {
      includeHiddenElements: true,
    });
    expect(highlight.props.children).toBe('every day');
    expect(highlight.props.style).toHaveProperty('backgroundColor');
    expect(highlight.props.style).toHaveProperty('color');
    expect(view.getAllByLabelText('Add a task')).toHaveLength(1);
  });

  it('tracks the native multiline input scroll', async () => {
    const view = await render(
      <Input
        accessibilityLabel="Add a task"
        value="A long task every day"
        highlights={[{ start: 12, end: 21, text: 'every day' }]}
        onChangeText={() => {}}
        multiline
      />,
    );

    await fireEvent.scroll(view.getByDisplayValue('A long task every day'), {
      nativeEvent: { contentOffset: { x: 0, y: 24 } },
    });

    expect(
      view.getByTestId('schedule-highlight-track', {
        includeHiddenElements: true,
      }).props.style,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transform: [{ translateY: -24 }] }),
      ]),
    );
  });

  it('dismisses recognition when a tap places the native caret in the range', async () => {
    const onDismissHighlight = jest.fn();
    const view = await render(
      <Input
        accessibilityLabel="Add a task"
        value="Stand up every day"
        highlights={[{ start: 9, end: 18, text: 'every day' }]}
        onDismissHighlight={onDismissHighlight}
        onChangeText={() => {}}
      />,
    );

    const input = view.getByDisplayValue('Stand up every day');
    await fireEvent(input, 'selectionChange', {
      nativeEvent: { selection: { start: 12, end: 12 } },
    });

    expect(onDismissHighlight).toHaveBeenCalledWith({
      start: 9,
      end: 18,
      text: 'every day',
    });
  });
});
