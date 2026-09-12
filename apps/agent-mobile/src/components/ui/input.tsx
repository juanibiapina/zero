import { forwardRef } from 'react';
import { TextInput, type TextInputProps } from 'react-native';

import { cn } from '@/lib/cn';

export type InputProps = TextInputProps & {
  className?: string;
  variant?: 'body' | 'editor';
};

// Borderless text input whose container owns the framing. Body is the default;
// editor gives task and project creation one typography token. Forwards its ref
// so callers can restore focus after a dialog.
export const Input = forwardRef<TextInput, InputProps>(function Input(
  { className, variant = 'body', ...props },
  ref,
) {
  return (
    <TextInput
      ref={ref}
      className={cn(
        variant === 'editor' ? 'text-editor' : 'text-body',
        'text-foreground',
        className,
      )}
      placeholderTextColorClassName="text-placeholder"
      {...props}
    />
  );
});
