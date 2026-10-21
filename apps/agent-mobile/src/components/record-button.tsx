import { Host, Icon } from '@expo/ui';
import { router } from 'expo-router';
import { Pressable } from 'react-native';

import { useColor } from '@/lib/theme';

const MIC_ICON = Icon.select({ ios: 'mic', android: import('@expo/material-symbols/mic.xml') });

export function RecordButton() {
  const color = useColor('--color-foreground-secondary');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Record a voice note"
      onPress={() => router.navigate({ pathname: '/browse/record', params: { source: 'app' } }, { withAnchor: true })}
      className="h-12 w-12 items-center justify-center rounded-full"
    >
      <Host matchContents><Icon name={MIC_ICON} size={24} color={color} /></Host>
    </Pressable>
  );
}
