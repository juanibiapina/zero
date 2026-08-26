import { Pressable, Text, type PressableProps } from 'react-native';

import { cn } from '@/lib/cn';

export type FabProps = Omit<PressableProps, 'children'> & {
  label: string;
  className?: string;
};

// Square primary action button showing a "+" glyph. `label` is the
// accessibility label (no icon library yet). Pin it with a positioning
// className from the caller (e.g. absolute bottom-6 right-6).
export function Fab({ label, className, disabled, ...props }: FabProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      className={cn(
        'h-14 w-14 items-center justify-center rounded-2xl bg-primary shadow-lg',
        disabled && 'opacity-60',
        className,
      )}
      {...props}
    >
      <Text className="text-3xl leading-none text-white">+</Text>
    </Pressable>
  );
}
