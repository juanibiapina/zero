import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';

import { ScreenHeader } from '../screen-header';

// The native Clerk button renders a platform view via requireNativeView, which
// is unavailable under jest; stub it out (returns nothing). jest hoists this
// above the import above.
jest.mock('@clerk/expo/native', () => ({
  UserButton: () => null,
}));

describe('ScreenHeader', () => {
  it('renders its title', async () => {
    const { getByText } = await render(<ScreenHeader title="Captures" />);
    expect(getByText('Captures')).toBeTruthy();
  });
});
