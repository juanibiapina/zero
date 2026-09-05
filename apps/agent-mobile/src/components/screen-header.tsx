import { UserButton } from '@clerk/expo/native';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';

// The header shared by Captures, Upcoming, and Projects: a large screen title
// on the left and the native account button on the right, padded below the
// status bar via the real safe-area inset (not a fixed pt-16). No wrapper on
// UserButton: a rounded-full/overflow-hidden mask crops the native avatar
// off-center.
export function ScreenHeader({ title }: { title: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="mb-2 flex-row items-center justify-between px-screen-x"
      style={{ paddingTop: insets.top + 12 }}
    >
      <Text variant="title">{title}</Text>
      <UserButton />
    </View>
  );
}
