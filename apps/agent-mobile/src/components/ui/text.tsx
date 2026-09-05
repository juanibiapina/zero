import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '@/lib/cn';

// Named type styles. Each maps to a `text-*` token in global.css (size +
// line-height + weight) plus a color token, so screens never restate a font
// size or color. `section` is the collapsible/section-header style.
const VARIANTS = {
  title: 'text-title text-foreground',
  section: 'text-section text-foreground',
  body: 'text-body text-foreground',
  subtitle: 'text-subtitle text-foreground-secondary',
  caption: 'text-caption text-foreground-secondary',
  error: 'text-caption text-danger text-center',
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
