// Fake `@clerk/expo/native` for the release E2E build. The home screen renders
// UserButton in its header; a plain stub keeps the layout without pulling in the
// real native Clerk component.
import { View } from 'react-native';

export function UserButton() {
  return <View accessibilityLabel="user-button" />;
}
