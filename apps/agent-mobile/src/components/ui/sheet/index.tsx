import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetSectionList,
  KEYBOARD_STATUS,
  useBottomSheetInternal,
  type BottomSheetBackdropProps,
  type BottomSheetModalProps,
} from '@gorhom/bottom-sheet';
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import {
  Keyboard,
  ScrollView,
  SectionList,
  TextInput,
  useWindowDimensions,
  type ScrollViewProps,
  type SectionListProps,
  type TextInputProps,
} from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColor } from '@/lib/theme';

import { androidBackPress, createSheetVisibility, type SheetVisibility } from './visibility';

export type ContextBridge = (children: ReactNode) => ReactNode;

export type SheetSize = 'fit' | 'expandable' | 'tall';

export type SheetProps = {
  open: boolean;
  onClose: () => void | false;
  size?: SheetSize;
  contextBridge: ContextBridge | null;
  children: ReactNode;
};

type FocusedInput = ReturnType<typeof TextInput.State.currentlyFocusedInput>;

const FIT_MAX_HEIGHT = 0.9;
const EXPANDABLE_SNAP_POINTS = ['60%', '100%'];
const TALL_SNAP_POINTS = ['85%'];
const SHEET_RADIUS = 28;

const SIZES: Record<SheetSize, Partial<BottomSheetModalProps>> = {
  fit: { enableDynamicSizing: true, keyboardBehavior: 'interactive' },
  expandable: { enableDynamicSizing: false, keyboardBehavior: 'extend', snapPoints: EXPANDABLE_SNAP_POINTS },
  tall: { enableDynamicSizing: false, keyboardBehavior: 'extend', snapPoints: TALL_SNAP_POINTS, enableContentPanningGesture: false },
};

export function Sheet({ open, onClose, size = 'fit', contextBridge, children }: SheetProps) {
  const modal = useRef<BottomSheetModal>(null);
  const onCloseRef = useRef(onClose);
  const blurred = useRef<FocusedInput>(null);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const surface = useColor('--color-surface');
  const handle = useColor('--color-foreground-muted');
  const scrim = useColor('--color-scrim');
  const [kept, setKept] = useState(children);
  if (open && kept !== children) setKept(children);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  const visibility = useRef<SheetVisibility | null>(null);

  useEffect(() => {
    const created = createSheetVisibility({
      controller: {
        present: () => modal.current?.present(),
        dismiss: () => modal.current?.dismiss(),
      },
      onClose: () => onCloseRef.current(),
      backPress: androidBackPress,
    });
    visibility.current = created;
    return () => {
      created.release();
      visibility.current = null;
    };
  }, []);

  useEffect(() => {
    if (open && Keyboard.isVisible()) {
      blurred.current = TextInput.State.currentlyFocusedInput();
      Keyboard.dismiss();
    }
    visibility.current?.setOpen(open);
  }, [open]);

  const handleChange = useCallback((index: number) => {
    if (index >= 0) visibility.current?.presented();
  }, []);

  const handleDismiss = useCallback(() => {
    if (visibility.current?.dismissed() === false) return;
    const input = blurred.current;
    blurred.current = null;
    const stillShown = input != null && (input as { isConnected?: boolean }).isConnected !== false;
    if (stillShown && TextInput.State.currentlyFocusedInput() == null) {
      TextInput.State.focusTextInput(input);
    }
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={1}
        pressBehavior="close"
        style={[props.style, scrim ? { backgroundColor: scrim } : null]}
      />
    ),
    [scrim],
  );

  const fitHeight = Math.round(height * FIT_MAX_HEIGHT);
  const content = open ? children : kept;
  const bridged = contextBridge ? contextBridge(content) : content;

  return (
    <BottomSheetModal
      ref={modal}
      {...SIZES[size]}
      maxDynamicContentSize={fitHeight}
      topInset={insets.top}
      stackBehavior="push"
      enableDismissOnClose
      enablePanDownToClose
      keyboardBlurBehavior="restore"
      onChange={handleChange}
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: surface, borderRadius: SHEET_RADIUS }}
      handleIndicatorStyle={handle ? { backgroundColor: handle } : undefined}
    >
      {size === 'fit' ? (
        <BottomSheetScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom }}>
          {bridged}
        </BottomSheetScrollView>
      ) : (
        <FixedBody bottom={insets.bottom}>{bridged}</FixedBody>
      )}
    </BottomSheetModal>
  );
}

function FixedBody({ bottom, children }: { bottom: number; children: ReactNode }) {
  const { animatedDetentsState, animatedKeyboardState, animatedLayoutState, animatedPosition } =
    useBottomSheetInternal();
  const style = useAnimatedStyle(() => {
    const { containerHeight, handleHeight } = animatedLayoutState.get();
    const keyboard = animatedKeyboardState.get();
    const lowest = animatedDetentsState.get().detents?.[0];
    const position = Math.min(animatedPosition.get(), lowest ?? animatedPosition.get());
    const keyboardHeight = keyboard.status === KEYBOARD_STATUS.SHOWN ? keyboard.heightWithinContainer : 0;
    return {
      height: Math.max(0, containerHeight - position - handleHeight - keyboardHeight),
      paddingBottom: keyboardHeight > 0 ? 0 : bottom,
    };
  }, [animatedDetentsState, animatedKeyboardState, animatedLayoutState, animatedPosition, bottom]);
  return <Animated.View style={[{ minHeight: 0, overflow: 'hidden' }, style]}>{children}</Animated.View>;
}

type FocusEvent = Parameters<NonNullable<TextInputProps['onFocus']>>[0];
type BlurEvent = Parameters<NonNullable<TextInputProps['onBlur']>>[0];

export function useSheetInputFocus(onFocus?: TextInputProps['onFocus'], onBlur?: TextInputProps['onBlur']) {
  const sheet = useBottomSheetInternal(true);
  const keyboard = sheet?.animatedKeyboardState;
  return useMemo(() => {
    if (!keyboard) return { onFocus, onBlur };
    return {
      onFocus: (event: FocusEvent) => {
        const target = event.nativeEvent.target;
        keyboard.set((state) => ({ ...state, target }));
        onFocus?.(event);
      },
      onBlur: (event: BlurEvent) => {
        if (keyboard.get().target === event.nativeEvent.target) {
          keyboard.set((state) => ({ ...state, target: undefined }));
        }
        onBlur?.(event);
      },
    };
  }, [keyboard, onFocus, onBlur]);
}

const ScrollViewInSheet = BottomSheetScrollView as unknown as typeof ScrollView;
const SectionListInSheet = BottomSheetSectionList as unknown as typeof SectionList;

export const SheetScrollView = forwardRef<ScrollView, ScrollViewProps>(function SheetScrollView(props, ref) {
  const Scroll = useBottomSheetInternal(true) ? ScrollViewInSheet : ScrollView;
  return <Scroll ref={ref} {...props} />;
});

function SheetSectionListImpl<Item, Section>(
  props: SectionListProps<Item, Section>,
  ref: Ref<SectionList<Item, Section>>,
) {
  const List = useBottomSheetInternal(true) ? SectionListInSheet : SectionList;
  return <List ref={ref} {...props} />;
}

export const SheetSectionList = forwardRef(SheetSectionListImpl) as <Item, Section>(
  props: SectionListProps<Item, Section> & { ref?: Ref<SectionList<Item, Section>> },
) => ReactElement;
