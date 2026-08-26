import { type Ref } from 'react';
import { Pressable, type TextInput, View } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
} from 'react-native-reanimated';

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
// cross-fading the two elements as `open` flips and lifting the open bar with
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
  // keyboard-controller's height is negative while the keyboard is shown, so it
  // maps straight onto translateY to lift the bar above the keyboard.
  const { height } = useReanimatedKeyboardAnimation();
  const riseStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: height.value }],
  }));

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

      {/* box-none lets taps through to the list where this container is empty
          (everywhere but the FAB) while it is collapsed. */}
      <View className="absolute inset-x-0 bottom-0" pointerEvents="box-none">
        {open ? (
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
            style={riseStyle}
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
        ) : (
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
            className="items-end px-6 pb-6"
          >
            <Fab label="Add todo" onPress={onOpen} />
          </Animated.View>
        )}
      </View>
    </>
  );
}
