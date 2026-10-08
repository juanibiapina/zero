import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

// A small keyboard-docked sheet that asks for one whole number of pills: the
// amount bought for Restock, or the pills on hand for Set count.
export function PillCountSheet({ title, initial, min = 1, saveLabel = 'Save', onSave, onClose }: {
  title: string;
  initial: number | null;
  min?: number;
  saveLabel?: string;
  onSave: (count: number) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState(initial === null ? '' : String(initial));
  const value = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  const valid = value !== null && value >= min;
  const save = () => { if (valid) onSave(value); };
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <Pressable accessibilityRole="button" accessibilityLabel="Close pill count" className="flex-1 bg-scrim" onPress={onClose} />
    <KeyboardStickyView style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
      <View style={{ paddingBottom: insets.bottom + 8 }} className="rounded-t-2xl bg-surface pt-2 shadow-raised">
        <View className="mb-1 h-1 w-9 self-center rounded-full bg-divider" />
        <Text className="px-screen-x pb-1 pt-2 text-[15px] font-semibold">{title}</Text>
        <View className="mx-screen-x my-2 min-h-12 flex-row items-center gap-2 rounded-xl bg-background px-3">
          <Input value={text} onChangeText={setText} accessibilityLabel={title} keyboardType="number-pad" autoFocus selectTextOnFocus returnKeyType="done" onSubmitEditing={save} className="min-h-12 flex-1" />
          <Text variant="subtitle">pills</Text>
        </View>
        <View className="flex-row justify-end gap-6 px-screen-x py-3">
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={8} onPress={onClose}><Text className="font-semibold text-accent">Cancel</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={saveLabel} accessibilityState={{ disabled: !valid }} disabled={!valid} hitSlop={8} onPress={save}><Text className={valid ? 'font-semibold text-accent' : 'font-semibold text-accent opacity-40'}>{saveLabel}</Text></Pressable>
        </View>
      </View>
    </KeyboardStickyView>
  </Modal>;
}
