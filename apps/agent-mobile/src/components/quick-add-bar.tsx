import { type Ref } from 'react';
import { type TextInput, View } from 'react-native';

import { Fab } from '@/components/ui/fab';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

export type QuickAddBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  // Fired by both the keyboard "done" key and the Add button.
  onSubmit: () => void;
  busy?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: Ref<TextInput>;
  // Accessibility label of the submit button. Defaults to the Capture wording.
  fabLabel?: string;
  // Optional persistent hint shown above the input (e.g. Projects teaches
  // outcome-based naming).
  helperText?: string;
};

// Presentational quick-add surface: a full-width panel with rounded top corners
// docked to the keyboard, a borderless text field, and a small circular submit.
// No animation, no keyboard or open/close logic — the transition layer owns
// those.
export function QuickAddBar({
  value,
  onChangeText,
  onSubmit,
  busy,
  placeholder = 'Capture a thought',
  autoFocus = true,
  inputRef,
  fabLabel = 'Capture',
  helperText,
}: QuickAddBarProps) {
  return (
    <View className="rounded-t-2xl bg-surface px-screen-x pb-4 pt-3 shadow-raised">
      {helperText ? (
        <Text variant="caption" className="mb-2">
          {helperText}
        </Text>
      ) : null}
      <View className="flex-row items-center gap-2">
        <Input
          ref={inputRef}
          className="flex-1"
          placeholder={placeholder}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmit}
          // Keep the keyboard up after submit so many items can be captured fast.
          blurOnSubmit={false}
          returnKeyType="done"
          autoFocus={autoFocus}
        />
        <Fab
          label={fabLabel}
          size="sm"
          // Disabled look while empty; the keyboard "done" key still closes the
          // bar on an empty input (handled by the caller's onSubmit).
          disabled={busy || value.trim().length === 0}
          onPress={onSubmit}
        />
      </View>
    </View>
  );
}
