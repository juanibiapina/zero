import { Pressable, Text, type PressableProps } from 'react-native';

import { cn } from '@/lib/cn';

export type FabProps = Omit<PressableProps, 'children'> & {
  label: string;
  className?: string;
};

// Floating action button: a circular primary Pressable showing a "+" glyph.
// `label` is the accessibility label (no icon library yet). Pin it with a
// positioning className from the caller (e.g. absolute bottom-6 right-6).
export function Fab({ label, className, ...props }: FabProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      className={cn(
        'h-14 w-14 items-center justify-center rounded-full bg-primary shadow-lg',
        className,
      )}
      {...props}
    >
      <Text className="text-3xl leading-none text-white">+</Text>
    </Pressable>
  );
}
