import { Pressable, View } from 'react-native';

import { cn } from '@/lib/cn';
import { Text } from '@/components/ui/text';

export type ConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// Centered confirm dialog rendered as an in-tree absolute overlay (NOT an RN
// Modal) so a focused input behind it keeps focus and the keyboard stays up.
// Tapping the scrim cancels. Two right-aligned text buttons; the confirm can be
// tinted destructive (red).
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <View className="absolute inset-0 items-center justify-center">
      {/* Scrim: tap outside the card to cancel. */}
      <Pressable
        accessibilityLabel="Dismiss dialog"
        className="absolute inset-0 bg-black/40"
        onPress={onCancel}
      />
      <View className="mx-8 w-full max-w-sm rounded-2xl bg-white p-6">
        <Text variant="title">{title}</Text>
        <Text variant="subtitle" className="mt-2">
          {message}
        </Text>
        <View className="mt-6 flex-row justify-end gap-6">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
            hitSlop={8}
            onPress={onCancel}
          >
            <Text className="font-semibold text-primary">{cancelLabel}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirmLabel}
            hitSlop={8}
            onPress={onConfirm}
          >
            <Text
              className={cn(
                'font-semibold',
                destructive ? 'text-red-600' : 'text-primary',
              )}
            >
              {confirmLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
