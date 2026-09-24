import { ADD_MODE_LABEL, addModeA11yLabel, type AddMode } from '@zero/agent-core';
import type { TextRange } from '@zeroapps/recurrence';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { Keyboard, Modal, Pressable, ScrollView, type TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardEvents, KeyboardStickyView } from 'react-native-keyboard-controller';

import { ScheduleHighlightInput } from '@/components/schedule-highlight-input';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/cn';
import { refocusAfterPresentation } from '@/lib/keyboard';

type EditorAction = {
  label: string;
  active: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  icon?: string | null;
  testID?: string;
  trailingAction?: {
    icon: ReactNode;
    accessibilityLabel: string;
    onPress: () => void;
    testID?: string;
  };
};

function EditorActionRow({
  label,
  active,
  onPress,
  accessibilityLabel,
  icon,
  testID,
  trailingAction,
}: EditorAction) {
  return (
    <View className="max-w-full flex-row items-stretch">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityValue={accessibilityLabel ? { text: label } : undefined}
        testID={testID}
        onPress={onPress}
        className="min-h-14 flex-1 flex-row items-center px-screen-x py-3.5"
      >
        <Text
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
      {trailingAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={trailingAction.accessibilityLabel}
          testID={trailingAction.testID}
          onPress={trailingAction.onPress}
          className="min-h-14 min-w-14 items-center justify-center px-3"
        >
          <View
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            {trailingAction.icon}
          </View>
        </Pressable>
      ) : null}
    </View>
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
    <View className="flex-row border-b border-divider px-screen-x">
      {modes.map((candidate) => {
        const selected = mode === candidate;
        return (
          <Pressable
            key={candidate}
            accessibilityRole="button"
            accessibilityLabel={addModeA11yLabel(candidate)}
            accessibilityState={{ selected }}
            onPress={() => onModeChange(candidate)}
            className="min-h-12 flex-1 items-center justify-end px-1 pt-2"
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
// hidden behind its window. Create opens without a native slide so the existing
// keyboard-sticky surface moves with the keyboard; edit retains the slide.
export function TaskEditorSheet({
  open, onClose, dismissLabel, draft, onChangeDraft, onSubmit,
  placeholder = 'Task', autoFocus = false, keyboardOnOpen = false, inputRef, inputAccessibilityLabel,
  leading, modeSelector, context, editorContent, trailing,
  scheduleAction, projectAction, overlay, highlightRanges, onDismissHighlight,
}: {
  open: boolean;
  onClose: () => void;
  dismissLabel: string;
  draft: string;
  onChangeDraft: (text: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  keyboardOnOpen?: boolean;
  inputRef?: Ref<{ focus: () => void }>;
  inputAccessibilityLabel?: string;
  leading?: ReactNode;
  modeSelector?: ReactNode;
  context?: ReactNode;
  editorContent?: ReactNode;
  trailing?: ReactNode;
  scheduleAction?: EditorAction;
  projectAction?: EditorAction;
  overlay?: ReactNode;
  highlightRanges?: TextRange[];
  onDismissHighlight?: (range: TextRange) => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const field = useRef<TextInput>(null);
  const presented = useRef(false);
  const previousAutoFocus = useRef(autoFocus);
  const keyboardStarted = useRef(false);
  const cancelRefocus = useRef<() => void>(() => {});
  useEffect(() => {
    const starting = KeyboardEvents.addListener('keyboardWillShow', () => {
      keyboardStarted.current = true;
      cancelRefocus.current();
    });
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      keyboardStarted.current = true;
      cancelRefocus.current();
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => { starting.remove(); show.remove(); hide.remove(); };
  }, []);
  useImperativeHandle(inputRef, () => ({ focus: () => field.current?.focus() }), []);
  const focusForCreate = useCallback(() => {
    cancelRefocus.current();
    keyboardStarted.current = Keyboard.isVisible();
    field.current?.focus();
    // Android may focus a field without showing its IME in a new Modal window.
    // Only recover if neither keyboard controller nor RN saw it start opening.
    const retry = setTimeout(() => {
      if (!keyboardStarted.current && !Keyboard.isVisible()) {
        cancelRefocus.current = refocusAfterPresentation(field.current, 0);
      }
    }, 220);
    cancelRefocus.current = () => clearTimeout(retry);
  }, []);
  useEffect(() => {
    if (!open) {
      presented.current = false;
      cancelRefocus.current();
    } else if (presented.current && autoFocus && !previousAutoFocus.current) {
      focusForCreate();
    } else if (!autoFocus) {
      cancelRefocus.current();
    }
    previousAutoFocus.current = autoFocus;
  }, [open, autoFocus, focusForCreate]);
  useEffect(() => () => cancelRefocus.current(), []);
  return (
    <Modal visible={open} transparent animationType={keyboardOnOpen ? 'none' : 'slide'} onRequestClose={onClose}
      onShow={() => {
        presented.current = true;
        previousAutoFocus.current = autoFocus;
        if (autoFocus) focusForCreate();
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
          <ScrollView style={{ maxHeight: Math.max(180, height - keyboardHeight - insets.top - insets.bottom - 32), flexGrow: 0 }} keyboardShouldPersistTaps="handled">
          <View
            testID="task-editor-grip"
            importantForAccessibility="no"
            className="mb-1 h-1 w-9 self-center rounded-full bg-divider"
          />
          {modeSelector}
          {context}
          {editorContent ?? (
            <View className="min-h-16 flex-row items-center gap-3 px-screen-x py-4">
              {leading}
              {highlightRanges ? (
                <ScheduleHighlightInput
                  ref={field}
                  value={draft}
                  ranges={highlightRanges}
                  onDismissRange={onDismissHighlight}
                  onChangeText={onChangeDraft}
                  onSubmitEditing={onSubmit}
                  returnKeyType="done"
                  blurOnSubmit
                  multiline
                  placeholder={placeholder}
                  accessibilityLabel={
                    inputAccessibilityLabel ??
                    (autoFocus ? 'New item text' : 'Task text')
                  }
                  autoFocus={false}
                  style={{ padding: 0, maxHeight: 120 }}
                  variant="editor"
                  className="flex-1"
                  testID="task-edit-input"
                />
              ) : (
                <Input
                  ref={field}
                  value={draft}
                  onChangeText={onChangeDraft}
                  onSubmitEditing={onSubmit}
                  returnKeyType="done"
                  blurOnSubmit
                  multiline
                  placeholder={placeholder}
                  accessibilityLabel={
                    inputAccessibilityLabel ??
                    (autoFocus ? 'New item text' : 'Task text')
                  }
                  autoFocus={false}
                  style={{ paddingTop: 0, paddingBottom: 0, maxHeight: 120 }}
                  variant="editor"
                  className="flex-1"
                  testID="task-edit-input"
                />
              )}
              {trailing}
            </View>
          )}
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
          </ScrollView>
        </View>
      </KeyboardStickyView>
      {overlay}
    </Modal>
  );
}
