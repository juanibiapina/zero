import { Pressable, Text, type PressableProps } from 'react-native';

import { cn } from '@/lib/cn';

export type FabProps = Omit<PressableProps, 'children'> & {
  label: string;
  size?: 'md' | 'sm';
  className?: string;
};

// Diameter per size. `md` is the floating action button; `sm` is the inline
// submit button inside the quick-add bar.
const SIZES = {
  md: 'h-14 w-14',
  sm: 'h-10 w-10',
} as const;

// Circular primary action button showing a "+" glyph. `label` is the
// accessibility label (no icon library yet). Pin it with a positioning
// className from the caller (e.g. absolute bottom-4 right-4).
export function Fab({
  label,
  size = 'md',
  className,
  disabled,
  ...props
}: FabProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      className={cn(
        'items-center justify-center rounded-full bg-accent shadow-lg',
        SIZES[size],
        disabled && 'opacity-40',
        className,
      )}
      {...props}
    >
      <Text
        className={cn(
          'leading-none text-on-accent',
          size === 'sm' ? 'text-2xl' : 'text-3xl',
        )}
      >
        +
      </Text>
    </Pressable>
  );
}
