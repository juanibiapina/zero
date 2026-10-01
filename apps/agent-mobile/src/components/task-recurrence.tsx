import { Host, Icon } from '@expo/ui';
import { taskRecurrenceLabel, type Task } from '@zero/agent-core';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { useColor } from '@/lib/theme';

const REPEAT_ICON = Icon.select({
  ios: 'repeat',
  android: import('@expo/material-symbols/repeat.xml'),
});

export function TaskRecurrence({ task }: { task: Task }) {
  const color = useColor('--color-foreground-secondary');
  const label = taskRecurrenceLabel(task);
  if (!label) return null;
  return (
    <View className="flex-row items-start gap-1">
      <View accessible={false} importantForAccessibility="no-hide-descendants">
        <Host matchContents><Icon name={REPEAT_ICON} size={14} color={color} /></Host>
      </View>
      <Text variant="caption" className="min-w-0 flex-1">{label}</Text>
    </View>
  );
}
