import { type Ref } from 'react';
import { type TextInput, View } from 'react-native';

import { Fab } from '@/components/ui/fab';
import { Input } from '@/components/ui/input';

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
};

// Presentational quick-add input row: a text field plus an Add button. No
// animation, no keyboard or open/close logic — the transition layer owns those.
// Reusable anywhere a single-line "type and submit" capture is needed.
export function QuickAddBar({
  value,
  onChangeText,
  onSubmit,
  busy,
  placeholder = 'Capture a thought',
  autoFocus = true,
  inputRef,
  fabLabel = 'Capture',
}: QuickAddBarProps) {
  return (
    <View className="flex-row items-center gap-2 rounded-2xl border border-neutral-200 bg-white px-3 py-2 shadow-lg">
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
        className="h-12 w-12"
        disabled={busy}
        onPress={onSubmit}
      />
    </View>
  );
}
