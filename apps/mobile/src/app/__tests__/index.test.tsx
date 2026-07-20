import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';

import HomeScreen from '../index';

describe('HomeScreen', () => {
  it('renders the app title', async () => {
    const { getByText } = await render(<HomeScreen />);
    expect(getByText('Zero Agent')).toBeTruthy();
  });
});
