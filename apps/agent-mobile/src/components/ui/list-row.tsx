import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useColor } from '@/lib/theme';

import { cn } from '@/lib/cn';

// The circle that Processes an item. A thin grey ring, 22dp, with a generous
// hitSlop so the visible target stays small (Todoist-style) while the tap
// target is comfortable. `label` is the accessibility label.
export function CheckCircle({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      className="h-[22px] w-[22px] rounded-full border-[1.5px] border-checkbox"
      hitSlop={8}
      onPress={onPress}
    />
  );
}

// A flat list row: a leading slot (check circle or emoji), the body, and an
// optional trailing slot, over an opaque background with a hairline divider
// beneath, inset to the body's left edge. This is the Todoist row shape shared
// by Upcoming and Projects; the Captures row is hand-built (it wraps a swipe
// gesture) but matches this vocabulary. Android press feedback is a ripple.
export function ListRow({
  leading,
  children,
  trailing,
  onPress,
  onLongPress,
  accessibilityLabel,
  className,
}: {
  leading?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  className?: string;
}) {
  const ripple = useColor('--color-ripple');
  return (
    <View className="bg-background">
      <Pressable
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        onLongPress={onLongPress}
        android_ripple={onPress ? { color: ripple } : undefined}
        className={cn('flex-row items-center gap-3 px-screen-x py-row-y', className)}
      >
        {leading}
        <View className="flex-1">{children}</View>
        {trailing}
      </Pressable>
      {/* Divider inset to the body: screen-x (16) + circle (22) + gap (12). */}
      <View className="ml-[50px] h-px bg-divider" />
    </View>
  );
}
