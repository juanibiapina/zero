import { type Ref } from 'react';
import { Pressable, type TextInput } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { QuickAddBar } from '@/components/quick-add-bar';
import { Fab } from '@/components/ui/fab';

export type QuickAddProps = {
  open: boolean;
  text: string;
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
};

// Transition layer between two independent, reusable elements: the collapsed
// `Fab` (plus button) and the expanded `QuickAddBar`. It owns ONLY the motion —
// cross-fading the two elements as `open` flips and keeping the open bar stuck to
// the keyboard — and knows nothing about todo state. The elements know nothing
// about the animation. Decoupled by design so either can be reused or restyled
// without touching the other.
export function QuickAdd({
  open,
  text,
  onChangeText,
  onOpen,
  onSubmit,
  onRequestClose,
  busy,
  inputRef,
}: QuickAddProps) {
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
        // edge-to-edge insets, keeping the bar glued to the keyboard as it
        // opens and closes. A hand-rolled translateY misaligns here (the bar/+
        // was left floating when the keyboard dismissed).
        <KeyboardStickyView className="absolute inset-x-0 bottom-0">
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
            className="px-4 pb-4"
          >
            <QuickAddBar
              value={text}
              onChangeText={onChangeText}
              onSubmit={onSubmit}
              busy={busy}
              inputRef={inputRef}
            />
          </Animated.View>
        </KeyboardStickyView>
      ) : (
        // Collapsed FAB, pinned bottom-right. box-none lets taps through to the
        // list everywhere except the FAB itself.
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          className="absolute inset-x-0 bottom-0 items-end px-6 pb-6"
          pointerEvents="box-none"
        >
          <Fab label="Add todo" onPress={onOpen} />
        </Animated.View>
      )}
    </>
  );
}
