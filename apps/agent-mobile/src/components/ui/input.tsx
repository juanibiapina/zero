import type { TextRange } from '@zeroapps/recurrence';
import { forwardRef, useState } from 'react';
import {
  Text as RNText,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
} from 'react-native';
import { useResolveClassNames } from 'uniwind';

import { useSheetInputFocus } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { useColor } from '@/lib/theme';

export type InputProps = TextInputProps & {
  className?: string;
  variant?: 'body' | 'editor';
  highlights?: TextRange[];
  onDismissHighlight?: (range: TextRange) => void;
};

type TextPart = {
  text: string;
  range: TextRange | null;
};

function textParts(value: string, ranges: TextRange[]): TextPart[] {
  const parts: TextPart[] = [];
  let offset = 0;

  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(offset, Math.min(value.length, range.start));
    const end = Math.max(start, Math.min(value.length, range.end));
    if (start > offset) parts.push({ text: value.slice(offset, start), range: null });
    if (end > start) parts.push({ text: value.slice(start, end), range });
    offset = end;
  }

  if (offset < value.length) parts.push({ text: value.slice(offset), range: null });
  return parts;
}

// Borderless text input whose container owns the framing. Body is the default;
// editor gives task and project creation one typography token. Forwards its ref
// so callers can restore focus after a dialog.
export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    className,
    variant = 'body',
    value,
    onChangeText,
    highlights,
    onDismissHighlight,
    onSelectionChange,
    onScroll,
    onFocus,
    onBlur,
    style,
    ...props
  },
  ref,
) {
  const focus = useSheetInputFocus(onFocus, onBlur);
  const [text, setText] = useState(value);
  const [ownerValue, setOwnerValue] = useState(value);
  if (value !== ownerValue) {
    setOwnerValue(value);
    setText(value);
  }
  const [scrollY, setScrollY] = useState(0);
  const foreground = useColor('--color-foreground');
  const scheduleHighlight = useColor('--color-schedule-highlight');
  const onScheduleHighlight = useColor('--color-on-schedule-highlight');
  const textStyle = useResolveClassNames(
    variant === 'editor' ? 'text-editor' : 'text-body',
  );
  const ranges = highlights ?? [];
  const highlighted = ranges.length > 0 && (text ?? '').length > 0;

  const input = (
    <TextInput
      ref={ref}
      className={cn(
        variant === 'editor' ? 'text-editor' : 'text-body',
        'text-foreground',
        !highlights && className,
      )}
      placeholderTextColorClassName="text-placeholder"
      {...props}
      value={value === undefined ? undefined : text}
      onChangeText={(next) => {
        setText(next);
        onChangeText?.(next);
      }}
      style={highlights ? [style, { width: '100%', color: highlighted ? 'transparent' : foreground }] : style}
      onSelectionChange={(event) => {
        onSelectionChange?.(event);
        const { start, end } = event.nativeEvent.selection;
        if (start !== end) return;
        const range = ranges.find((candidate) => start >= candidate.start && start < candidate.end);
        if (range) onDismissHighlight?.(range);
      }}
      onScroll={(event) => {
        setScrollY(event.nativeEvent.contentOffset.y);
        onScroll?.(event);
      }}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
    />
  );
  if (!highlights) return input;

  return (
    <View className={cn('relative', className)}>
      {highlighted ? (
        // Android's EditText still paints dark glyph fills for a transparent
        // text color. The inert mirror sits above them; the native caret,
        // selection, IME, and touch target remain active underneath.
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="schedule-highlight-mirror"
          style={{ zIndex: 1 }}
          className="absolute inset-0 overflow-hidden"
        >
          <RNText
            testID="schedule-highlight-track"
            style={[
              textStyle,
              style as StyleProp<TextStyle>,
              { color: foreground, transform: [{ translateY: -scrollY }] },
            ]}
          >
            {textParts(text ?? '', ranges).map((part, index) =>
              part.range ? (
                <RNText
                  key={`${part.range.start}-${part.range.end}`}
                  testID="schedule-highlight"
                  className="bg-schedule-highlight text-on-schedule-highlight"
                  style={{
                    backgroundColor: scheduleHighlight,
                    color: onScheduleHighlight,
                  }}
                >
                  {part.text}
                </RNText>
              ) : (
                <RNText key={`plain-${index}`}>{part.text}</RNText>
              ),
            )}
          </RNText>
        </View>
      ) : null}
      {input}
    </View>
  );
});
