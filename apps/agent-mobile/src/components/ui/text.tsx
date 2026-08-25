import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '@/lib/cn';

const VARIANTS = {
  title: 'text-2xl font-semibold text-neutral-900',
  subtitle: 'text-base text-neutral-600',
  body: 'text-base text-neutral-900',
  error: 'text-sm text-red-600 text-center',
} as const;

export type TextVariant = keyof typeof VARIANTS;

export type TextProps = RNTextProps & {
  variant?: TextVariant;
  className?: string;
};

// Typed text with named variants so screens don't re-specify type styles.
export function Text({ variant = 'body', className, ...props }: TextProps) {
  return <RNText className={cn(VARIANTS[variant], className)} {...props} />;
}
