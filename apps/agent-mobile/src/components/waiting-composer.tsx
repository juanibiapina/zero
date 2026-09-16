import { useRef, useState } from 'react';
import { Modal, Pressable, type TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';

import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { refocusAfterPresentation } from '@/lib/keyboard';

type WaitingComposerProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (text: string) => void;
};

export function WaitingComposer(props: WaitingComposerProps) {
  return props.open ? <OpenWaitingComposer {...props} /> : null;
}

function OpenWaitingComposer({
  onClose,
  onAdd,
}: WaitingComposerProps) {
  const [text, setText] = useState('');
  const field = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setText('');
  };

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => refocusAfterPresentation(field.current)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel waiting condition"
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <KeyboardStickyView style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <View
          style={{ paddingBottom: insets.bottom + 8 }}
          className="rounded-t-2xl bg-surface px-screen-x pb-2 pt-3 shadow-raised"
        >
          <View importantForAccessibility="no" className="mb-3 h-1 w-9 self-center rounded-full bg-divider" />
          <Text className="pb-3 text-[20px] font-semibold">Add waiting condition</Text>
          <Input
            ref={field}
            value={text}
            onChangeText={setText}
            onSubmitEditing={submit}
            returnKeyType="done"
            blurOnSubmit
            multiline
            autoFocus
            placeholder="What are you waiting for?"
            accessibilityLabel="Waiting condition"
            variant="editor"
            className="min-h-16"
          />
          <View className="flex-row justify-end gap-2 pt-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              className="min-h-12 min-w-16 items-center justify-center px-3"
              onPress={onClose}
            >
              <Text className="font-medium text-foreground-secondary">Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add waiting condition"
              accessibilityState={{ disabled: !text.trim() }}
              disabled={!text.trim()}
              className="min-h-12 min-w-16 items-center justify-center px-3"
              onPress={submit}
            >
              <Text className={text.trim() ? 'font-semibold text-accent' : 'font-semibold text-foreground-muted'}>
                Add
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardStickyView>
    </Modal>
  );
}
