import type { ReactNode } from 'react';
import { View } from 'react-native';
import { EmojiKeyboard, type EmojiType } from 'rn-emoji-keyboard';

import { Sheet } from '@/components/ui/sheet';
import { useColor } from '@/lib/theme';

// A tall sheet hosting the inline build of rn-emoji-keyboard. `header` sits
// above the grid, followed by a divider.
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
    <Sheet open={open} onClose={onClose} tall>
      <View className="flex-1">
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
    </Sheet>
  );
}
