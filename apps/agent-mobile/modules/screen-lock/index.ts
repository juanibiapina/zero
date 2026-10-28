import { requireOptionalNativeModule } from 'expo';

type NativeScreenLock = { lockScreen(): void };

const native = typeof requireOptionalNativeModule === 'function'
  ? requireOptionalNativeModule<NativeScreenLock>('ScreenLock')
  : null;

/** Locks the phone. If the app's accessibility service is off, opens
 *  Accessibility settings instead. Does nothing when the native module is
 *  missing (Jest, web, iOS). */
export function lockScreen(): void {
  native?.lockScreen();
}
