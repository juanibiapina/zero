import { ADD_MODE_LABEL, addModeA11yLabel, type AddMode } from '@zero/agent-core';
import { useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';
import { Modal, Pressable, type TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';

import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/cn';

type EditorAction = {
  label: string;
  active: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  icon?: string | null;
  testID?: string;
};

function EditorActionRow({
  label,
  active,
  onPress,
  accessibilityLabel,
  icon,
  testID,
}: EditorAction) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityValue={accessibilityLabel ? { text: label } : undefined}
      testID={testID}
      onPress={onPress}
      className="min-h-14 max-w-full flex-row items-center px-screen-x py-3.5"
    >
      <Text
        numberOfLines={1}
        className={cn(
          'flex-1 text-[16px]',
          active
            ? 'font-medium text-accent'
            : 'text-foreground-secondary',
        )}
      >
        {icon != null ? `${icon} ${label}` : label}
      </Text>
    </Pressable>
  );
}

export function AddModeSelector({
  mode,
  modes,
  onModeChange,
}: {
  mode: AddMode;
  modes: AddMode[];
  onModeChange: (mode: AddMode) => void;
}) {
  return (
    <View className="flex-row gap-6 border-b border-divider px-screen-x">
      {modes.map((candidate) => {
        const selected = mode === candidate;
        return (
          <Pressable
            key={candidate}
            accessibilityRole="button"
            accessibilityLabel={addModeA11yLabel(candidate)}
            accessibilityState={{ selected }}
            onPress={() => onModeChange(candidate)}
            className="min-h-12 justify-end pt-2"
          >
            <Text
              variant="subtitle"
              className={cn(
                'pb-2 font-medium',
                selected ? 'text-accent' : 'text-foreground-secondary',
              )}
            >
              {ADD_MODE_LABEL[candidate]}
            </Text>
            <View
              className={cn(
                'h-0.5',
                selected ? 'bg-accent' : 'bg-transparent',
              )}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

// Create and edit share the Modal, keyboard docking, title and metadata rows.
// The visual hierarchy follows the former edit drawer: grip, identity, then
// full-width actions. Their controllers own persistence. Overlays live inside
// the Modal because an in-tree discard dialog rendered outside it would be
// hidden behind its window.
export function TaskEditorSheet({
  open, onClose, dismissLabel, draft, onChangeDraft, onSubmit,
  placeholder = 'Task', autoFocus = false, inputRef,
  leading, modeSelector, trailing, scheduleAction, projectAction, overlay,
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
  modeSelector?: ReactNode;
  trailing?: ReactNode;
  scheduleAction?: EditorAction;
  projectAction?: EditorAction;
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
          className="rounded-t-2xl bg-surface pt-2 shadow-raised"
        >
          <View
            testID="task-editor-grip"
            importantForAccessibility="no"
            className="mb-1 h-1 w-9 self-center rounded-full bg-divider"
          />
          {modeSelector}
          <View className="min-h-16 flex-row items-center gap-3 px-screen-x py-4">
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
              variant="editor"
              className="flex-1"
              testID="task-edit-input"
            />
            {trailing}
          </View>
          {scheduleAction || projectAction ? (
            <View className="border-t border-divider">
              {scheduleAction ? (
                <EditorActionRow {...scheduleAction} />
              ) : null}
              {scheduleAction && projectAction ? (
                <View className="h-px bg-divider" />
              ) : null}
              {projectAction ? <EditorActionRow {...projectAction} /> : null}
            </View>
          ) : null}
        </View>
      </KeyboardStickyView>
      {overlay}
    </Modal>
  );
}
