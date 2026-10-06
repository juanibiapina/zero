import type { ReactNode } from 'react';
import { Modal, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmojiKeyboard, type EmojiType } from 'rn-emoji-keyboard';

import { useColor } from '@/lib/theme';

// A plain RN bottom sheet (a Modal + backdrop + a tall bottom-anchored panel),
// NOT an @expo/ui native sheet, because it hosts the raw-RN `EmojiKeyboard` (the
// inline, non-modal build of rn-emoji-keyboard); hosting RN rows inside the
// @expo/ui native tree breaks them. The panel is fixed at 85% height so the
// keyboard's search bar stays above the on-screen keyboard. `header` sits above
// the grid, followed by a divider.
export function EmojiPickerSheet({
  open,
  onClose,
  onPick,
  header,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
  header?: ReactNode;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // rn-emoji-keyboard is themed by literal colors, not CSS vars — resolve the app
  // tokens the same way the rest of the screen does.
  const emojiTheme = {
    backdrop: useColor('--color-scrim'),
    knob: useColor('--color-divider'),
    container: useColor('--color-surface'),
    header: useColor('--color-foreground'),
    skinTonesContainer: useColor('--color-surface-muted'),
    category: {
      icon: useColor('--color-foreground-muted'),
      iconActive: useColor('--color-accent'),
      container: useColor('--color-surface'),
      containerActive: useColor('--color-surface-muted'),
    },
    search: {
      background: useColor('--color-surface-muted'),
      text: useColor('--color-foreground'),
      placeholder: useColor('--color-placeholder'),
      icon: useColor('--color-foreground-muted'),
    },
    emoji: { selected: useColor('--color-surface-muted') },
  };

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close icon picker"
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <View
        style={{ height: Math.round(height * 0.85), paddingBottom: insets.bottom }}
        className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-surface"
      >
        {header ? (
          <>
            {header}
            <View className="h-px bg-divider" />
          </>
        ) : null}
        <View className="flex-1">
          <EmojiKeyboard
            onEmojiSelected={(picked: EmojiType) => onPick(picked.emoji)}
            enableSearchBar
            enableRecentlyUsed={false}
            theme={emojiTheme}
          />
        </View>
      </View>
    </Modal>
  );
}
