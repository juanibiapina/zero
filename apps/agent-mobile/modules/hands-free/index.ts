import { requireOptionalNativeModule } from 'expo';

export type HandsFreeKey = 'accept' | 'speak' | 'repeat' | 'stop';
export type HandsFreeTake = { uri: string; durationMs: number };

type NativeHandsFree = {
  start(): boolean;
  stop(): void;
  startRecording(): void;
  finishRecording(): HandsFreeTake | null;
  addListener(event: 'onKey', listener: (event: { key: HandsFreeKey }) => void): { remove(): void };
};

const native = typeof requireOptionalNativeModule === 'function'
  ? requireOptionalNativeModule<NativeHandsFree>('HandsFree')
  : null;

export type HandsFreeControls = {
  onKey(listener: (key: HandsFreeKey) => void): () => void;
  startRecording(): void;
  finishRecording(): HandsFreeTake | null;
  release(): void;
};

export function takeHandsFreeControls(): HandsFreeControls | null {
  if (!native || !native.start()) return null;
  let released = false;
  return {
    onKey(listener) {
      const subscription = native.addListener('onKey', ({ key }) => listener(key));
      return () => subscription.remove();
    },
    startRecording: () => native.startRecording(),
    finishRecording: () => native.finishRecording(),
    release() {
      if (released) return;
      released = true;
      native.stop();
    },
  };
}
