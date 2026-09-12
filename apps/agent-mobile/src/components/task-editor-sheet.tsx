import { ADD_MODE_LABEL, addModeA11yLabel, type AddMode } from '@zero/agent-core';
import { useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';
import { Modal, Pressable, type TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';

import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/cn';

type EditorChip = {
  label: string;
  active: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  icon?: string | null;
  testID?: string;
};

function Chip({ label, active, onPress, accessibilityLabel, icon, testID }: EditorChip) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityValue={accessibilityLabel ? { text: label } : undefined}
      testID={testID}
      onPress={onPress}
      className={cn(
        'min-h-12 max-w-full justify-center rounded-full border px-3 py-2',
        active ? 'border-accent bg-accent/10' : 'border-divider',
      )}
    >
      <Text variant="caption" numberOfLines={1} className={cn(active && 'text-accent')}>
        {icon != null ? `${icon} ${label}` : label}
      </Text>
    </Pressable>
  );
}

export function ModePills({ mode, modes, onModeChange }: {
  mode: AddMode;
  modes: AddMode[];
  onModeChange: (mode: AddMode) => void;
}) {
  return (
    <View className="mb-1 flex-row flex-wrap gap-2">
      {modes.map((m) => (
        <Pressable
          key={m}
          accessibilityRole="button"
          accessibilityLabel={addModeA11yLabel(m)}
          accessibilityState={{ selected: mode === m }}
          onPress={() => onModeChange(m)}
          className={cn(
            'min-h-12 justify-center rounded-full px-3 py-2',
            mode === m ? 'bg-accent' : 'bg-surface-muted',
          )}
        >
          <Text variant="caption" className={cn(mode === m && 'text-on-accent')}>
            {ADD_MODE_LABEL[m]}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// Create and edit share the Modal, keyboard docking, title and metadata chips.
// Their controllers own persistence. Overlays live inside the Modal because an
// in-tree discard dialog rendered outside it would be hidden behind its window.
export function TaskEditorSheet({
  open, onClose, dismissLabel, draft, onChangeDraft, onSubmit,
  placeholder = 'Task', autoFocus = false, inputRef,
  leading, pills, trailing, dateChip, projectChip, overlay,
}: {
  open: boolean;
  onClose: () => void;
  dismissLabel: string;
  draft: string;
  onChangeDraft: (text: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: Ref<{ focus: () => void }>;
  leading?: ReactNode;
  pills?: ReactNode;
  trailing?: ReactNode;
  dateChip?: EditorChip;
  projectChip?: EditorChip;
  overlay?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const field = useRef<TextInput>(null);
  useImperativeHandle(inputRef, () => ({ focus: () => field.current?.focus() }), []);
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}
      onShow={() => {
        // Android may focus before the Modal owns a window, without opening IME.
        if (autoFocus) {
          field.current?.blur();
          field.current?.focus();
        }
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={dismissLabel}
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <KeyboardStickyView style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <View
          accessibilityLabel="sheet"
          style={{ paddingBottom: insets.bottom + 8 }}
          className="rounded-t-2xl bg-surface px-screen-x pt-3 shadow-raised"
        >
          {pills}
          <View className="flex-row items-center gap-3 py-3">
            {leading}
            <Input
              ref={field}
              value={draft}
              onChangeText={onChangeDraft}
              onSubmitEditing={onSubmit}
              returnKeyType="done"
              blurOnSubmit
              multiline
              placeholder={placeholder}
              accessibilityLabel={autoFocus ? 'New item text' : 'Task text'}
              autoFocus={autoFocus}
              style={{ paddingTop: 0, paddingBottom: 0, maxHeight: 120 }}
              className="flex-1 text-[18px] font-semibold leading-6"
              testID="task-edit-input"
            />
            {trailing}
          </View>
          {dateChip || projectChip ? (
            <View className="flex-row flex-wrap gap-2 pb-1">
              {dateChip ? <Chip {...dateChip} /> : null}
              {projectChip ? <Chip {...projectChip} /> : null}
            </View>
          ) : null}
        </View>
      </KeyboardStickyView>
      {overlay}
    </Modal>
  );
}
