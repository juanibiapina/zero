import { Pressable, Text, type PressableProps } from 'react-native';

import { cn } from '@/lib/cn';

const CONTAINER = {
  primary: 'bg-primary',
  secondary: 'bg-neutral-200',
} as const;

const LABEL = {
  primary: 'text-white',
  secondary: 'text-neutral-900',
} as const;

export type ButtonVariant = keyof typeof CONTAINER;

export type ButtonProps = Omit<PressableProps, 'children'> & {
  label: string;
  variant?: ButtonVariant;
  className?: string;
};

// Pressable button with primary/secondary variants. Disabled state dims it.
export function Button({
  label,
  variant = 'primary',
  className,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <Pressable
      className={cn(
        'items-center rounded-lg px-6 py-3',
        CONTAINER[variant],
        disabled && 'opacity-60',
        className,
      )}
      disabled={disabled}
      {...props}
    >
      <Text className={cn('text-base font-semibold', LABEL[variant])}>
        {label}
      </Text>
    </Pressable>
  );
}
