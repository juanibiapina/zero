import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';

import { Fab } from '../fab';

describe('Fab', () => {
  it('renders its accessibility label', async () => {
    const { getByLabelText } = await render(<Fab label="Add todo" />);
    expect(getByLabelText('Add todo')).toBeTruthy();
  });

  it('calls onPress when tapped', async () => {
    const onPress = jest.fn();
    const { getByLabelText } = await render(
      <Fab label="Add todo" onPress={onPress} />,
    );
    fireEvent.press(getByLabelText('Add todo'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
