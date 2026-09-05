import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import { CheckCircle, ListRow } from '../list-row';

describe('CheckCircle', () => {
  it('calls onPress and exposes its label', async () => {
    const onPress = jest.fn();
    const { getByLabelText } = await render(
      <CheckCircle label={'Process "buy milk"'} onPress={onPress} />,
    );
    fireEvent.press(getByLabelText('Process "buy milk"'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('ListRow', () => {
  it('renders leading, body, and trailing slots', async () => {
    const { getByText, toJSON } = await render(
      <ListRow
        leading={<Text>icon</Text>}
        trailing={<Text>undo</Text>}
        onPress={() => {}}
      >
        <Text>body</Text>
      </ListRow>,
    );
    expect(getByText('icon')).toBeTruthy();
    expect(getByText('body')).toBeTruthy();
    expect(getByText('undo')).toBeTruthy();
    expect(JSON.stringify(toJSON())).toContain('bg-ripple');
  });

  it('fires onPress and onLongPress from the row', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const { getByLabelText } = await render(
      <ListRow
        accessibilityLabel="Buy milk"
        onPress={onPress}
        onLongPress={onLongPress}
      >
        <Text>buy milk</Text>
      </ListRow>,
    );
    fireEvent.press(getByLabelText('Buy milk'));
    fireEvent(getByLabelText('Buy milk'), 'longPress');
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
