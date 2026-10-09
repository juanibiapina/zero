import { useEffect, useRef, useState } from 'react';
import { Pressable, type TextInput, View } from 'react-native';

import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

const SHEET_FOCUS_DELAY_MS = 300;

// A small sheet that asks for one whole number of pills: the amount bought for
// Restock, or the pills on hand for Count pills and Recount.
export function PillCountSheet({ open, title, initial, min = 1, saveLabel = 'Save', onSave, onClose }: {
  open: boolean;
  title: string;
  initial: number | null;
  min?: number;
  saveLabel?: string;
  onSave: (count: number) => void;
  onClose: () => void;
}) {
  return <Sheet open={open} onClose={onClose}>
    <PillCountForm title={title} initial={initial} min={min} saveLabel={saveLabel} onSave={onSave} onClose={onClose} />
  </Sheet>;
}

function PillCountForm({ title, initial, min, saveLabel, onSave, onClose }: {
  title: string;
  initial: number | null;
  min: number;
  saveLabel: string;
  onSave: (count: number) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial === null ? '' : String(initial));
  const input = useRef<TextInput>(null);
  useEffect(() => {
    const focus = setTimeout(() => input.current?.focus(), SHEET_FOCUS_DELAY_MS);
    return () => clearTimeout(focus);
  }, []);
  const value = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  const valid = value !== null && value >= min;
  const save = () => { if (valid) onSave(value); };
  return <View className="pb-2">
    <Text className="px-screen-x pb-1 text-[15px] font-semibold">{title}</Text>
    <View className="mx-screen-x my-2 min-h-12 flex-row items-center gap-2 rounded-xl bg-background px-3">
      <Input ref={input} value={text} onChangeText={setText} accessibilityLabel={title} keyboardType="number-pad" selectTextOnFocus returnKeyType="done" onSubmitEditing={save} className="min-h-12 flex-1" />
      <Text variant="subtitle">pills</Text>
    </View>
    <View className="flex-row justify-end gap-6 px-screen-x py-3">
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={8} onPress={onClose}><Text className="font-semibold text-accent">Cancel</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={saveLabel} accessibilityState={{ disabled: !valid }} disabled={!valid} hitSlop={8} onPress={save}><Text className={valid ? 'font-semibold text-accent' : 'font-semibold text-accent opacity-40'}>{saveLabel}</Text></Pressable>
    </View>
  </View>;
}
