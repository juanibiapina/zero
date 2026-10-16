import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, View, type TextInput } from 'react-native';

import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

const COLLAPSED_LINES = 4;

export function ProjectDescription({
  value,
  onChange,
  onBlur,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lines, setLines] = useState(0);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!editing) return;
    const subscription = Keyboard.addListener('keyboardDidHide', () => inputRef.current?.blur());
    return () => subscription.remove();
  }, [editing]);

  if (editing || value.trim() === '') {
    return (
      <Input
        ref={inputRef}
        value={value}
        onChangeText={(next) => {
          setEditing(true);
          onChange(next);
        }}
        autoFocus={editing}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          onBlur();
        }}
        multiline
        placeholder="What outcome are you after, and why does it matter?"
        accessibilityLabel="Project description"
        placeholderTextColorClassName="text-foreground-secondary"
        className="text-subtitle"
      />
    );
  }

  return (
    <View className="items-start gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Edits the project description"
        onPress={() => setEditing(true)}
        className="relative w-full"
      >
        <Text
          variant="subtitle"
          className="text-foreground"
          numberOfLines={expanded ? undefined : COLLAPSED_LINES}
        >
          {value}
        </Text>
        <Text
          variant="subtitle"
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onTextLayout={(event) => setLines(event.nativeEvent.lines.length)}
          className="absolute left-0 right-0 top-0 opacity-0"
        >
          {value}
        </Text>
      </Pressable>
      {lines > COLLAPSED_LINES ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={9}
          onPress={() => setExpanded((open) => !open)}
        >
          <Text variant="caption" className="font-medium text-foreground">
            {expanded ? 'Less' : 'More'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
