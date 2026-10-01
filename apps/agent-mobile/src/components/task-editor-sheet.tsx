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
import {
  KeyboardEvents,
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useResolveClassNames } from 'uniwind';

import { ScheduleHighlightInput } from '@/components/schedule-highlight-input';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/cn';
import { useColor } from '@/lib/theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const FAB_SIZE = 56;
const FAB_EDGE_GAP = 24;
const SHEET_RADIUS = 16;
const ENTER_DURATION = 300;
const EXIT_DURATION = 250;
const MATERIAL_STANDARD = Easing.bezier(0.4, 0, 0.2, 1);

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
  onOpen, onKeyboardWillHide, collapsedFabLabel,
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
  onOpen?: () => void;
  onKeyboardWillHide?: () => void;
  collapsedFabLabel?: string;
}) {
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [bottomGap, setBottomGap] = useState(0);
  const [sheetHeight, setSheetHeight] = useState(0);
  const screen = useRef<View>(null);
  const field = useRef<TextInput>(null);
  const previouslyFocusedForOpen = useRef(false);
  const progress = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const accent = useColor('--color-accent');
  const surface = useColor('--color-surface');
  const shellBaseStyle = useResolveClassNames('shadow-raised');
  useEffect(() => {
    const shouldFocus = inline && open && autoFocus;
    if (shouldFocus && !previouslyFocusedForOpen.current) field.current?.focus();
    previouslyFocusedForOpen.current = shouldFocus;
  }, [inline, open, autoFocus]);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) =>
      setKeyboardHeight(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => {
    if (!inline || !open || onKeyboardWillHide == null) return;
    const hide = KeyboardEvents.addListener(
      'keyboardWillHide',
      onKeyboardWillHide,
    );
    return () => hide.remove();
  }, [inline, open, onKeyboardWillHide]);
  useImperativeHandle(inputRef, () => ({ focus: () => field.current?.focus() }), []);
  useEffect(() => {
    if (!inline || sheetHeight === 0) return;
    progress.set(
      withTiming(open ? 1 : 0, {
        duration: reduceMotion ? 0 : open ? ENTER_DURATION : EXIT_DURATION,
        easing: MATERIAL_STANDARD,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [inline, open, progress, reduceMotion, sheetHeight]);
  const measureBottomGap = useCallback(() => {
    if (!inline || open) return;
    screen.current?.measureInWindow((_x, y, _width, screenHeight) => {
      setBottomGap(Math.max(0, height - y - screenHeight));
    });
  }, [height, inline, open]);
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.35, 1], [0, 0, 1], Extrapolation.CLAMP),
  }));
  const shellStyle = useAnimatedStyle(() => {
    const value = progress.get();
    return {
      width: interpolate(value, [0, 1], [FAB_SIZE, width]),
      height: interpolate(value, [0, 1], [FAB_SIZE, sheetHeight || FAB_SIZE]),
      borderRadius: interpolate(value, [0, 1], [FAB_SIZE / 2, SHEET_RADIUS]),
      backgroundColor: interpolateColor(value, [0, 1], [accent, surface]),
      transform: [
        { translateX: interpolate(value, [0, 1], [-FAB_EDGE_GAP, 0]) },
        { translateY: interpolate(value, [0, 1], [-FAB_EDGE_GAP, 0]) },
      ],
    };
  });
  const sheetContentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0.16, 0.46], [0, 1], Extrapolation.CLAMP),
  }));
  const plusStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.24], [1, 0], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(progress.get(), [0, 0.24], [1, 0.9], Extrapolation.CLAMP) }],
  }));

  const sheetBody = (
    <View
      accessibilityLabel="sheet"
      style={{ paddingBottom: insets.bottom + 8 }}
      className={cn(!inline && 'rounded-t-2xl bg-surface pt-2 shadow-raised', inline && 'pt-2')}
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
              autoFocus={inline && open && autoFocus}
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
              autoFocus={inline && open && autoFocus}
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
            <EditorActionRow {...scheduleAction}
              trailingAction={highlightRanges?.[0] && onDismissHighlight ? {
                icon: <Text className="text-[20px]">×</Text>,
                accessibilityLabel: 'Keep schedule words in task title',
                onPress: () => onDismissHighlight(highlightRanges[0]),
                testID: inline ? 'quick-add-unrecognize-schedule' : undefined,
              } : scheduleAction.trailingAction}
            />
          ) : null}
          {scheduleAction && projectAction ? (
            <View className="h-px bg-divider" />
          ) : null}
          {projectAction ? <EditorActionRow {...projectAction} /> : null}
        </View>
      ) : null}
      </ScrollView>
    </View>
  );
  const modalContent = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={dismissLabel}
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <KeyboardStickyView
        offset={{ opened: 0 }}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
      >
        {sheetBody}
      </KeyboardStickyView>
      {overlay}
    </>
  );
  if (!inline) {
    return (
      <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
        {modalContent}
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
      <>
          <AnimatedPressable
            accessibilityLabel={dismissLabel}
            accessibilityElementsHidden={!open}
            importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
            pointerEvents={open ? 'auto' : 'none'}
            onPress={onClose}
            style={[{ position: 'absolute', inset: 0 }, scrimStyle]}
          >
            <View className="flex-1 bg-scrim" />
          </AnimatedPressable>
          {!open && onOpen != null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={collapsedFabLabel}
              onPress={onOpen}
              style={{
                position: 'absolute',
                right: FAB_EDGE_GAP,
                bottom: FAB_EDGE_GAP,
                width: FAB_SIZE,
                height: FAB_SIZE,
                zIndex: 1,
              }}
            />
          ) : null}
          <KeyboardStickyView
            offset={{ opened: bottomGap }}
            pointerEvents="box-none"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'flex-end' }}
          >
            {/* 32 dp covers the ~27 dp lead observed on the Pixel 7. */}
            <KeyboardGapFill height={bottomGap + insets.bottom + 32} />
            <Animated.View
              testID="task-editor-morph-shell"
              pointerEvents={open || onOpen != null ? 'auto' : 'none'}
              style={[
                shellBaseStyle,
                { overflow: 'hidden', opacity: open || onOpen != null ? 1 : 0 },
                shellStyle,
              ]}
            >
              <Animated.View
                testID="task-editor-morph-content"
                accessibilityElementsHidden={!open}
                importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
                onLayout={(event) => setSheetHeight(event.nativeEvent.layout.height)}
                style={[
                  {
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width,
                  },
                  sheetContentStyle,
                ]}
              >
                {sheetBody}
              </Animated.View>
              <Animated.View
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  {
                    position: 'absolute',
                    inset: 0,
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                  plusStyle,
                ]}
              >
                <Text className="text-3xl leading-none text-on-accent">+</Text>
              </Animated.View>
            </Animated.View>
          </KeyboardStickyView>
          {overlay}
        </>
    </View>
  );
}
