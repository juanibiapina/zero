import { BottomSheet, type BottomSheetMethods } from '@expo/ui/community/bottom-sheet';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColor } from '@/lib/theme';

const SHEET_CHROME = 64;
const MIN_CONTENT_HEIGHT = 180;

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  tall?: boolean;
  children: ReactNode;
};

export function Sheet({ open, onClose, tall = false, children }: SheetProps) {
  const sheet = useRef<BottomSheetMethods>(null);
  const [presented, setPresented] = useState(open);
  const openRef = useRef(open);
  const onCloseRef = useRef(onClose);
  const surface = useColor('--color-surface');
  const [kept, setKept] = useState(children);
  if (open && kept !== children) setKept(children);
  if (open && !presented) setPresented(true);

  useEffect(() => {
    openRef.current = open;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) sheet.current?.close();
  }, [open]);

  const closed = useCallback(() => {
    setPresented(false);
    if (openRef.current) onCloseRef.current();
  }, []);

  if (!presented) return null;
  return (
    <BottomSheet
      ref={sheet}
      index={0}
      enablePanDownToClose
      onClose={closed}
      backgroundStyle={surface ? { backgroundColor: surface } : undefined}
    >
      <SheetContent tall={tall}>{open ? children : kept}</SheetContent>
    </BottomSheet>
  );
}

function SheetContent({ tall, children }: { tall: boolean; children: ReactNode }) {
  const { height } = useWindowDimensions();
  const available = useAvailableHeight();
  return (
    <View
      style={tall
        ? { height: Math.min(Math.round(height * 0.85) - SHEET_CHROME, available) }
        : { maxHeight: available }}
    >
      {children}
    </View>
  );
}

function useAvailableHeight() {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) => setKeyboard(event.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return Math.max(MIN_CONTENT_HEIGHT, height - insets.top - insets.bottom - keyboard - SHEET_CHROME);
}
