import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';

const mockUseAuth = jest.fn();

jest.mock('@clerk/clerk-expo', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    const { Text } = require('react-native');
    return <Text>redirect:{href}</Text>;
  },
  Stack: () => {
    const { Text } = require('react-native');
    return <Text>stack</Text>;
  },
}));

import SignedInLayout from '../(signed-in)/_layout';

describe('SignedInLayout', () => {
  it('shows a loading indicator until Clerk is loaded', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: false, isSignedIn: false });
    const { toJSON } = await render(<SignedInLayout />);
    expect(JSON.stringify(toJSON())).toContain('ActivityIndicator');
  });

  it('redirects to sign-in when signed out', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    const { getByText } = await render(<SignedInLayout />);
    expect(getByText('redirect:/sign-in')).toBeTruthy();
  });

  it('renders the stack when signed in', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true });
    const { getByText } = await render(<SignedInLayout />);
    expect(getByText('stack')).toBeTruthy();
  });
});
