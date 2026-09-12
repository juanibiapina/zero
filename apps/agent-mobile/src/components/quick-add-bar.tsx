import { type Ref } from 'react';
import { Pressable, type TextInput, View } from 'react-native';
import {
  ADD_MODE_LABEL,
  ADD_MODE_PLACEHOLDER,
  ALL_ADD_MODES,
  addModeA11yLabel,
  type AddMode,
} from '@zero/agent-core';

import { Fab } from '@/components/ui/fab';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/cn';

export type QuickAddBarProps = {
  value: string;
  // When set, the mode pills show above the input. The offered set is `modes`
  // (default: all three); `mode` is the selected one and must be one of them. A
  // single-element `modes` yields one interactive pill (the project screen's
  // task-only add) that reads exactly like Home's — it is just the only option.
  mode?: AddMode;
  modes?: AddMode[];
  onModeChange?: (mode: AddMode) => void;
  onChangeText: (text: string) => void;
  // Fired by both the keyboard "done" key and the Add button.
  onSubmit: () => void;
  busy?: boolean;
  // Overrides the placeholder. Without it, a selected mode's placeholder comes
  // from the registry; with no mode either, it falls back to the capture prompt.
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: Ref<TextInput>;
  // Accessibility label of the submit button. Defaults to the Capture wording.
  fabLabel?: string;
  // The create-time date + project composer chips (Home quick-add). Rendered as
  // a row below the input when both handlers are supplied. The date is the sole
  // commitment gate, so this is how a quick-add task lands on Home / Upcoming or
  // is filed to a project. See docs/plans/todo-retire-take-on.md.
  dateChipLabel?: string;
  dateChipActive?: boolean;
  onDateChipPress?: () => void;
  projectChipLabel?: string;
  projectChipActive?: boolean;
  onProjectChipPress?: () => void;
};

// Presentational quick-add surface: a full-width panel with rounded top corners
// docked to the keyboard, a borderless text field, and a small circular submit.
// No animation, no keyboard or open/close logic — the transition layer owns
// those. The mode concept (ids, pill copy, placeholders) lives in the shared
// add-mode registry, so this widget renders whatever modes it is handed.
export function QuickAddBar({
  value,
  mode,
  modes = ALL_ADD_MODES,
  onModeChange,
  onChangeText,
  onSubmit,
  busy,
  placeholder,
  autoFocus = true,
  inputRef,
  fabLabel = 'Task',
  dateChipLabel,
  dateChipActive,
  onDateChipPress,
  projectChipLabel,
  projectChipActive,
  onProjectChipPress,
}: QuickAddBarProps) {
  const resolvedPlaceholder =
    placeholder ?? (mode ? ADD_MODE_PLACEHOLDER[mode] : 'Add a task');
  const showChips = onDateChipPress != null && onProjectChipPress != null;
  return (
    <View className="rounded-t-2xl bg-surface px-screen-x pb-4 pt-3 shadow-raised">
      {mode ? (
        <View className="mb-2 flex-row gap-2">
          {modes.map((m) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityLabel={addModeA11yLabel(m)}
              accessibilityState={{ selected: mode === m }}
              onPress={() => onModeChange?.(m)}
              className={cn(
                'rounded-full px-3 py-1',
                mode === m ? 'bg-accent' : 'bg-surface-muted',
              )}
            >
              <Text
                variant="caption"
                className={cn(mode === m && 'text-on-accent')}
              >
                {ADD_MODE_LABEL[m]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View className="flex-row items-center gap-2">
        <Input
          ref={inputRef}
          className="flex-1"
          placeholder={resolvedPlaceholder}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmit}
          // The caller closes the bar on a real submit; blurOnSubmit stays false
          // only so an empty submit does not flap the keyboard before it closes.
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
      {showChips ? (
        <View className="mt-2 flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dateChipLabel}
            onPress={onDateChipPress}
            className={cn(
              'rounded-full border px-3 py-1',
              dateChipActive ? 'border-accent bg-accent/10' : 'border-divider',
            )}
          >
            <Text
              variant="caption"
              className={cn(dateChipActive && 'text-accent')}
            >
              {dateChipLabel}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={projectChipLabel}
            onPress={onProjectChipPress}
            className={cn(
              'rounded-full border px-3 py-1',
              projectChipActive ? 'border-accent bg-accent/10' : 'border-divider',
            )}
          >
            <Text
              variant="caption"
              className={cn(projectChipActive && 'text-accent')}
            >
              {projectChipLabel}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
