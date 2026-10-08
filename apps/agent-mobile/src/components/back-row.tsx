import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';

export type BackLink = { label: string; accessibilityLabel: string; onPress: () => void };

export function BackRow({ label, accessibilityLabel, onPress }: BackLink) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 12 }} className="px-screen-x pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        hitSlop={8}
        onPress={onPress}
      >
        <Text className="text-[16px] text-accent">‹ {label}</Text>
      </Pressable>
    </View>
  );
}
