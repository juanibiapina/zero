import {
  PROJECT_DISPLAY_STATUS_LABELS,
  type Project,
  type ProjectDisplayStatus,
} from '@zero/agent-core';
import { View } from 'react-native';

import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';

// The shared Project row used by the Projects list and Home's all-clear view.
// Derived status and context stay with the caller so each screen can keep one
// snapshot for grouping, ordering, and row copy.
export function ProjectListRow({
  project,
  status,
  context,
  onPress,
}: {
  project: Project;
  status: ProjectDisplayStatus;
  context: string | null;
  onPress: () => void;
}) {
  const icon = (
    <View className="w-[22px] items-center">
      <Text className="text-[20px]">{project.icon}</Text>
    </View>
  );
  const trailing = context ? (
    <Text
      numberOfLines={1}
      variant="caption"
      className="max-w-[50%] shrink-0"
      accessibilityLabel={
        status === 'after'
          ? `After ${context.replace(/^after /, '')}`
          : `${PROJECT_DISPLAY_STATUS_LABELS[status]} ${context}`
      }
    >
      {context}
    </Text>
  ) : undefined;

  return (
    <ListRow
      leading={icon}
      trailing={trailing}
      accessibilityLabel={project.title}
      onPress={onPress}
      className="min-h-12"
    >
      <Text>{project.title}</Text>
    </ListRow>
  );
}
