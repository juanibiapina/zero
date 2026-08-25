import { TextInput, type TextInputProps } from 'react-native';

import { cn } from '@/lib/cn';

export type InputProps = TextInputProps & {
  className?: string;
};

// Single-line text input styled with NativeWind, matching the Button/Text base
// components.
export function Input({ className, ...props }: InputProps) {
  return (
    <TextInput
      className={cn(
        'rounded-lg border border-neutral-300 px-4 py-3 text-base text-neutral-900',
        className,
      )}
      placeholderTextColor="#9ca3af"
      {...props}
    />
  );
}
