import {
  BottomSheet,
  type BottomSheetContentPadding,
} from '@expo/ui';

// A generic, entity-agnostic bottom sheet: a thin wrapper over the universal
// @expo/ui BottomSheet (a real SwiftUI sheet on iOS, a Jetpack Compose
// ModalBottomSheet on Android), so gesture, animation, and the accessibility
// floor come from the OS — not @gorhom/bottom-sheet or a hand-rolled Reanimated
// sheet. It knows nothing about any entity: callers pass native @expo/ui content
// as `children` (the BottomSheet renders them in a native tree). Sibling of the
// web `ui/sheet`, sharing the same `{ open, onClose, children }` contract.
//
// The component stays mounted and toggles `isPresented`; `snapPoints` is omitted
// so the sheet auto-sizes to its (short) content. Back/scrim dismiss map to
// `onClose`.
export type SheetProps = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  contentPadding?: BottomSheetContentPadding;
};

export function Sheet({
  open,
  onClose,
  children,
  contentPadding,
}: SheetProps) {
  return (
    <BottomSheet
      isPresented={open}
      onDismiss={onClose}
      contentPadding={contentPadding}
    >
      {children}
    </BottomSheet>
  );
}
