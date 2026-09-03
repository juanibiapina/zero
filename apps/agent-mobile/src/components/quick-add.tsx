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
  // Wording of the collapsed FAB and the input placeholder. Defaults keep the
  // Capture copy so existing callers need no change; the Today list overrides
  // both. The FAB label doubles as its accessibility label.
  fabLabel?: string;
  placeholder?: string;
  // Distance (dp) from the screen's content bottom to the window bottom — the
  // native bottom tab bar plus the system gesture inset. The screen is inset
  // above the tab bar, but the keyboard-sticky bar lifts by the full keyboard
  // height (measured from the window bottom), so without this it over-lifts by
  // exactly this gap and floats above the keyboard. Added back as the open
  // offset so the bar docks flush to the keyboard. The caller measures it.
  bottomOffset?: number;
};

// Transition layer between two independent, reusable elements: the collapsed
// `Fab` (plus button) and the expanded `QuickAddBar`. It owns ONLY the motion —
// cross-fading the two elements as `open` flips and keeping the open bar stuck to
// the keyboard — and knows nothing about capture state. The elements know nothing
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
  fabLabel = 'Capture',
  placeholder,
  bottomOffset = 0,
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
        <KeyboardStickyView
          offset={{ opened: bottomOffset }}
          className="absolute inset-x-0 bottom-0"
        >
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
              fabLabel={fabLabel}
              placeholder={placeholder}
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
          <Fab label={fabLabel} onPress={onOpen} />
        </Animated.View>
      )}
    </>
  );
}
