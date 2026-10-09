import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { Text } from 'react-native';

import { Sheet } from '../sheet';

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

});
