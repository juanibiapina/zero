import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { stopRefine, useRefineSession } from '@/lib/refine-session';

// The refine session banner: pinned while a capture is being refined into tasks
// and projects. Done consumes the capture; Cancel leaves it. Shown on Today and
// Projects (the session is shared). `onFinish` processes the capture (each
// screen passes its own captures data layer).
export function RefineBanner({
  onFinish,
}: {
  onFinish: (captureId: string) => void;
}) {
  const session = useRefineSession();
  if (!session) return null;
  return (
    <View className="flex-row items-center gap-3 border-b border-divider bg-surface-muted px-screen-x py-2">
      <Text className="flex-1 text-[13px]" numberOfLines={1}>
        🔧 Refining: {session.text}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Finish refining"
        hitSlop={8}
        onPress={() => onFinish(session.id)}
      >
        <Text className="text-[13px] font-semibold text-accent">Done</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel refining"
        hitSlop={8}
        onPress={() => stopRefine()}
      >
        <Text className="text-[13px] text-foreground-muted">Cancel</Text>
      </Pressable>
    </View>
  );
}
