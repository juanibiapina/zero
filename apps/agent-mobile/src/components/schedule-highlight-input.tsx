import type { TextRange } from '@zeroapps/recurrence';
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  Text as RNText,
  TextInput as RNTextInput,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInput,
  type TextInputScrollEventData,
  type TextInputSelectionChangeEventData,
  type TextStyle,
} from 'react-native';
import { useResolveClassNames } from 'uniwind';

import type { InputProps } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { useColor } from '@/lib/theme';

export type ScheduleHighlightInputProps = Omit<
  InputProps,
  'className' | 'placeholderTextColorClassName' | 'value'
> & {
  className?: string;
  value: string;
  ranges: TextRange[];
  onDismissRange?: (range: TextRange) => void;
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

export const ScheduleHighlightInput = forwardRef<
  TextInput,
  ScheduleHighlightInputProps
>(function ScheduleHighlightInput(
  {
    className,
    variant = 'body',
    value,
    ranges,
    onDismissRange,
    onSelectionChange,
    onScroll,
    selectionColor,
    cursorColor,
    placeholderTextColor,
    style,
    ...props
  },
  forwardedRef,
) {
  const inputRef = useRef<TextInput>(null);
  const [scrollY, setScrollY] = useState(0);
  const accent = useColor('--color-accent');
  const foreground = useColor('--color-foreground');
  const placeholder = useColor('--color-placeholder');
  const scheduleHighlight = useColor('--color-schedule-highlight');
  const onScheduleHighlight = useColor('--color-on-schedule-highlight');
  const textStyle = useResolveClassNames(
    variant === 'editor' ? 'text-editor' : 'text-body',
  );
  const highlighted = ranges.length > 0 && value.length > 0;

  useImperativeHandle(forwardedRef, () => inputRef.current!, []);

  const dismissAtSelection = (selection: { start: number; end: number }) => {
    if (selection.start !== selection.end) return;
    const range = ranges.find(
      (candidate) =>
        selection.start >= candidate.start && selection.start < candidate.end,
    );
    if (range) onDismissRange?.(range);
  };

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
            {textParts(value, ranges).map((part, index) =>
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
      <RNTextInput
        {...props}
        ref={inputRef}
        value={value}
        style={[
          textStyle,
          style,
          { width: '100%', color: highlighted ? 'transparent' : foreground },
        ]}
        placeholderTextColor={placeholderTextColor ?? placeholder}
        selectionColor={selectionColor ?? accent}
        cursorColor={cursorColor ?? accent}
        onSelectionChange={(
          event: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
        ) => {
          onSelectionChange?.(event);
          dismissAtSelection(event.nativeEvent.selection);
        }}
        onScroll={(event: NativeSyntheticEvent<TextInputScrollEventData>) => {
          setScrollY(event.nativeEvent.contentOffset.y);
          onScroll?.(event);
        }}
      />
    </View>
  );
});
