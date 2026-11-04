import { requireOptionalNativeModule } from 'expo';

type NativeBackgroundUpload = {
  start(): boolean;
  stop(): void;
};

const native = typeof requireOptionalNativeModule === 'function'
  ? requireOptionalNativeModule<NativeBackgroundUpload>('BackgroundUpload')
  : null;

// While busy, a foreground service with a "Sending voice note" notification
// keeps Android from freezing the app, so an upload finishes after the user
// leaves. Without the native module, or when Android refuses to start the
// service from the background, the upload runs as before.
export function keepRunningWhileUploading(busy: boolean): void {
  if (!native) return;
  if (busy) native.start();
  else native.stop();
}
