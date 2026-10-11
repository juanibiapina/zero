import { BackHandler } from 'react-native';

export type SheetController = {
  present: () => void;
  dismiss: () => void;
};

export type BackPressSource = {
  subscribe: (onBackPress: () => boolean) => () => void;
};

type Phase = 'closed' | 'presenting' | 'presented' | 'dismissing';

export type SheetVisibility = ReturnType<typeof createSheetVisibility>;

export const androidBackPress: BackPressSource = {
  subscribe(onBackPress) {
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  },
};

export function createSheetVisibility({
  controller,
  onClose,
  backPress,
}: {
  controller: SheetController;
  onClose: () => void | false;
  backPress: BackPressSource;
}) {
  let phase: Phase = 'closed';
  let wanted = false;
  let ownerDismissed = false;
  let releaseBack: (() => void) | null = null;

  const setPhase = (next: Phase) => {
    phase = next;
    const wantsBack = phase === 'presented';
    if (wantsBack === (releaseBack != null)) return;
    if (wantsBack) {
      releaseBack = backPress.subscribe(() => {
        dismiss(false);
        return true;
      });
    } else {
      releaseBack?.();
      releaseBack = null;
    }
  };

  const present = () => {
    if (phase !== 'closed') return;
    setPhase('presenting');
    controller.present();
  };

  const dismiss = (byOwner: boolean) => {
    if (phase === 'closed' || phase === 'dismissing') return;
    ownerDismissed = byOwner;
    setPhase('dismissing');
    controller.dismiss();
  };

  return {
    setOpen(open: boolean) {
      wanted = open;
      if (open) present();
      else dismiss(true);
    },
    presented() {
      if (phase === 'presenting') setPhase('presented');
    },
    dismissed(): boolean {
      const byOwner = phase === 'dismissing' && ownerDismissed;
      ownerDismissed = false;
      setPhase('closed');
      if (byOwner) {
        if (!wanted) return true;
        present();
        return false;
      }
      if (!wanted || onClose() !== false) return true;
      present();
      return false;
    },
    release() {
      setPhase('closed');
    },
  };
}
