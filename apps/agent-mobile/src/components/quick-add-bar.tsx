import { type Ref } from 'react';
import { Pressable, type TextInput, View } from 'react-native';

import { Fab } from '@/components/ui/fab';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/cn';

export type QuickAddBarMode = 'capture' | 'task';

export type QuickAddBarProps = {
  value: string;
  // When provided, a Capture/Task toggle shows above the input.
  mode?: QuickAddBarMode;
  onModeChange?: (mode: QuickAddBarMode) => void;
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
  mode,
  onModeChange,
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
      {mode && onModeChange ? (
        <View className="mb-2 flex-row gap-2">
          {(['capture', 'task'] as const).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityLabel={m === 'task' ? 'Add a task' : 'Add a capture'}
              accessibilityState={{ selected: mode === m }}
              onPress={() => onModeChange(m)}
              className={cn(
                'rounded-full px-3 py-1',
                mode === m ? 'bg-accent' : 'bg-surface-muted',
              )}
            >
              <Text
                variant="caption"
                className={cn('capitalize', mode === m && 'text-on-accent')}
              >
                {m}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
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
