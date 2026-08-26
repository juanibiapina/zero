import { forwardRef } from 'react';
import { TextInput, type TextInputProps } from 'react-native';

import { cn } from '@/lib/cn';

export type InputProps = TextInputProps & {
  className?: string;
};

// Single-line text input styled with NativeWind, matching the Button/Text base
// components. Forwards its ref to the underlying TextInput so callers can
// focus it (e.g. to restore the keyboard after a dialog).
export const Input = forwardRef<TextInput, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <TextInput
      ref={ref}
      className={cn(
        'rounded-lg border border-neutral-300 px-4 py-3 text-base text-neutral-900',
        className,
      )}
      placeholderTextColor="#9ca3af"
      {...props}
    />
  );
});
