import type { TextInput } from 'react-native';

const PRESENTATION_SETTLE_MS = 100;
const REFOCUS_GAP_MS = 50;

type FocusableInput = Pick<TextInput, 'blur' | 'focus'>;

// Android can mark an input focused before a new Modal or animated panel owns a
// window, leaving the keyboard closed. Separate blur and focus so the second
// focus occurs after the surface is mounted and presented.
export function refocusAfterPresentation(
  input: FocusableInput | null,
): () => void {
  let focusTimer: ReturnType<typeof setTimeout> | null = null;
  const blurTimer = setTimeout(() => {
    input?.blur();
    focusTimer = setTimeout(() => input?.focus(), REFOCUS_GAP_MS);
  }, PRESENTATION_SETTLE_MS);
  return () => {
    clearTimeout(blurTimer);
    if (focusTimer) clearTimeout(focusTimer);
  };
}
