import { requireOptionalNativeModule } from 'expo';

export type MicKind = 'phone' | 'bluetooth' | 'bluetooth-le' | 'hearing-aid' | 'wired' | 'usb' | 'other';
export type Microphone = { name: string | null; kind: MicKind };
export type HeadsetRoute = { release(): void };

type NativeHeadsetMic = {
  routeToHeadset(): Promise<boolean>;
  releaseHeadset(): void;
  watchRecordingInput(): void;
  unwatchRecordingInput(): void;
  addListener(event: 'onRecordingInput', listener: (event: { mic: Microphone | null }) => void): { remove(): void };
};

const native = typeof requireOptionalNativeModule === 'function'
  ? requireOptionalNativeModule<NativeHeadsetMic>('HeadsetMic')
  : null;

export async function routeToHeadset(): Promise<HeadsetRoute | null> {
  if (!native || !(await native.routeToHeadset())) return null;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      native.releaseHeadset();
    },
  };
}

export function watchRecordingInput(onInput: (mic: Microphone | null) => void): (() => void) | null {
  if (!native) return null;
  const subscription = native.addListener('onRecordingInput', ({ mic }) => onInput(mic));
  native.watchRecordingInput();
  return () => {
    subscription.remove();
    native.unwatchRecordingInput();
  };
}
