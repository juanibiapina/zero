import { type Ref } from 'react';
import { Pressable, type TextInput } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useResolveClassNames } from 'uniwind';
import { type AddMode } from '@zero/agent-core';

import { QuickAddBar } from '@/components/quick-add-bar';
import { Fab } from '@/components/ui/fab';

export type QuickAddProps = {
  open: boolean;
  text: string;
  // When provided, the bar shows the mode pills above the input. `modes` chooses
  // which pills are offered (default: all three); a single-element list is one
  // interactive pill (the project screen's task-only add).
  mode?: AddMode;
  modes?: AddMode[];
  onModeChange?: (mode: AddMode) => void;
  onChangeText: (text: string) => void;
  // Collapsed FAB tapped: request opening the bar.
  onOpen: () => void;
  // Bar submitted (keyboard "done" or Add button).
  onSubmit: () => void;
  // Backdrop tapped: request dismissing the bar (the caller decides whether to
  // confirm a discard or close outright).
  onRequestClose: () => void;
  busy?: boolean;
  inputRef?: Ref<TextInput>;
  // Wording of the collapsed FAB and the input placeholder. Defaults keep the
  // Capture copy so existing callers need no change; the Projects list overrides
  // both. The FAB label doubles as its accessibility label.
  fabLabel?: string;
  placeholder?: string;
  // The create-time date + project composer chips (Home quick-add), forwarded to
  // the bar. Rendered only when both press handlers are supplied.
  dateChipLabel?: string;
  dateChipActive?: boolean;
  onDateChipPress?: () => void;
  projectChipLabel?: string;
  projectChipActive?: boolean;
  onProjectChipPress?: () => void;
  // Distance (dp) from the screen's content bottom to the window bottom — the
  // native bottom tab bar plus the system gesture inset. The keyboard-sticky
  // bar lifts by the full keyboard height (from the window bottom), so without
  // this it over-lifts by exactly this gap and floats above the keyboard. Added
  // back as the open offset so the bar docks flush to the keyboard.
  bottomOffset?: number;
};

// Transition layer between two independent, reusable elements: the collapsed
// `Fab` (plus button) and the expanded `QuickAddBar`. It owns ONLY the motion —
// cross-fading the two as `open` flips and keeping the open bar stuck to the
// keyboard — and knows nothing about capture state. Animated.View and
// KeyboardStickyView are not RN core components, so Uniwind does not map
// `className` onto them; their layout comes from resolved styles / inline style.
export function QuickAdd({
  open,
  text,
  mode,
  modes,
  onModeChange,
  onChangeText,
  onOpen,
  onSubmit,
  onRequestClose,
  busy,
  inputRef,
  fabLabel = 'Task',
  placeholder,
  dateChipLabel,
  dateChipActive,
  onDateChipPress,
  projectChipLabel,
  projectChipActive,
  onProjectChipPress,
  bottomOffset = 0,
}: QuickAddProps) {
  // Collapsed FAB wrapper: pinned bottom-right; box-none lets taps through to
  // the list everywhere except the FAB itself.
  const fabWrapStyle = useResolveClassNames(
    'absolute inset-x-0 bottom-0 items-end px-screen-x pb-6',
  );

  return (
    <>
      {/* Backdrop: only present while open; tap outside to dismiss. */}
      {open ? (
        <Pressable
          accessibilityLabel="Dismiss quick add"
          className="absolute inset-0"
          onPress={onRequestClose}
        />
      ) : null}

      {open ? (
        // KeyboardStickyView tracks the keyboard and handles Android
        // edge-to-edge insets, keeping the bar glued to the keyboard as it opens
        // and closes. A hand-rolled translateY misaligns here.
        <KeyboardStickyView
          offset={{ opened: bottomOffset }}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        >
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
          >
            <QuickAddBar
              value={text}
              mode={mode}
              modes={modes}
              onModeChange={onModeChange}
              onChangeText={onChangeText}
              onSubmit={onSubmit}
              busy={busy}
              inputRef={inputRef}
              fabLabel={fabLabel}
              placeholder={placeholder}
              dateChipLabel={dateChipLabel}
              dateChipActive={dateChipActive}
              onDateChipPress={onDateChipPress}
              projectChipLabel={projectChipLabel}
              projectChipActive={projectChipActive}
              onProjectChipPress={onProjectChipPress}
            />
          </Animated.View>
        </KeyboardStickyView>
      ) : (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          style={fabWrapStyle}
          pointerEvents="box-none"
        >
          <Fab label={fabLabel} onPress={onOpen} />
        </Animated.View>
      )}
    </>
  );
}
