import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';

import { ScheduleHighlightInput } from '../schedule-highlight-input';

describe('ScheduleHighlightInput', () => {
  it('shows only the parser-consumed text as an inline highlight', async () => {
    const view = await render(
      <ScheduleHighlightInput
        accessibilityLabel="Add a task"
        value="Stand up every day"
        ranges={[{ start: 9, end: 18, text: 'every day' }]}
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
      <ScheduleHighlightInput
        accessibilityLabel="Add a task"
        value="A long task every day"
        ranges={[{ start: 12, end: 21, text: 'every day' }]}
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
    const onDismissRange = jest.fn();
    const view = await render(
      <ScheduleHighlightInput
        accessibilityLabel="Add a task"
        value="Stand up every day"
        ranges={[{ start: 9, end: 18, text: 'every day' }]}
        onDismissRange={onDismissRange}
        onChangeText={() => {}}
      />,
    );

    const input = view.getByDisplayValue('Stand up every day');
    await fireEvent(input, 'selectionChange', {
      nativeEvent: { selection: { start: 12, end: 12 } },
    });

    expect(onDismissRange).toHaveBeenCalledWith({
      start: 9,
      end: 18,
      text: 'every day',
    });
  });
});
