import { forwardRef } from 'react';
import { TextInput, type TextInputProps } from 'react-native';

import { cn } from '@/lib/cn';

export type InputProps = TextInputProps & {
  className?: string;
};

// Single-line text input. Borderless by default (its container — e.g. the
// quick-add surface — owns the framing), body type, token placeholder color.
// Forwards its ref so callers can focus it (e.g. to restore the keyboard after
// a dialog).
export const Input = forwardRef<TextInput, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <TextInput
      ref={ref}
      className={cn('text-body text-foreground', className)}
      placeholderTextColorClassName="text-placeholder"
      {...props}
    />
  );
});
