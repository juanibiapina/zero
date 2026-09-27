import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';

import BrowseScreen from '../browse';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (path: string) => mockPush(path) }),
}));
jest.mock('@clerk/expo', () => ({
  useUser: () => ({ user: null }),
}));

describe('Browse', () => {
  beforeEach(() => { mockPush.mockClear(); });

  it('opens Upcoming from its menu', async () => {
    const { getByText, getByLabelText } = await render(<BrowseScreen />);
    expect(getByText('Browse')).toBeTruthy();
    fireEvent.press(getByLabelText('Upcoming'));
    expect(mockPush).toHaveBeenCalledWith('/browse/upcoming');
  });
});
