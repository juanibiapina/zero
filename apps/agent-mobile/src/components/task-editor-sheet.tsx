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
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { ScheduleHighlightInput } from '@/components/schedule-highlight-input';
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

// The sticky drawer can lead the IME by a frame; extend its surface over the exposed scrim.
function KeyboardGapFill({ height }: { height: number }) {
  const { progress } = useReanimatedKeyboardAnimation();
  const visibility = useAnimatedStyle(() => ({ opacity: progress.get() > 0 ? 1 : 0 }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', left: 0, right: 0, bottom: -height, height }, visibility]}
    >
      <View className="flex-1 bg-surface" />
    </Animated.View>
  );
}

// Create and edit share the title, metadata rows, and keyboard docking.
// Creation stays in the screen window so its input can open the keyboard on
// mount. Editing keeps the native Modal and its slide. The discard overlay
// stays in the same window as its drawer.
export function TaskEditorSheet({
  open, onClose, dismissLabel, draft, onChangeDraft, onSubmit,
  placeholder = 'Task', autoFocus = false, inline = false, inputRef, inputAccessibilityLabel,
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
  inline?: boolean;
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
  const [bottomGap, setBottomGap] = useState(0);
  const screen = useRef<View>(null);
  const field = useRef<TextInput>(null);
  const previousAutoFocus = useRef(autoFocus);
  useEffect(() => {
    if (inline && open && autoFocus && !previousAutoFocus.current) field.current?.focus();
    previousAutoFocus.current = autoFocus;
  }, [inline, open, autoFocus]);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) =>
      setKeyboardHeight(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  useImperativeHandle(inputRef, () => ({ focus: () => field.current?.focus() }), []);
  const measureBottomGap = useCallback(() => {
    if (!inline || open) return;
    screen.current?.measureInWindow((_x, y, _width, screenHeight) => {
      setBottomGap(Math.max(0, height - y - screenHeight));
    });
  }, [height, inline, open]);
  const content = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={dismissLabel}
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <KeyboardStickyView
        offset={{ opened: inline ? bottomGap : 0 }}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
      >
        {/* 32 dp covers the ~27 dp lead observed on the Pixel 7. */}
        {inline ? <KeyboardGapFill height={bottomGap + insets.bottom + 32} /> : null}
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
                  autoFocus={inline && autoFocus}
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
                  autoFocus={inline && autoFocus}
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
    </>
  );
  if (!inline) {
    return (
      <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
        {content}
      </Modal>
    );
  }
  return (
    <View
      ref={screen}
      onLayout={measureBottomGap}
      pointerEvents="box-none"
      className="absolute inset-0"
    >
      {open ? content : null}
    </View>
  );
}
