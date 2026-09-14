import { NativeModule, requireNativeModule } from 'expo';

import type { NativeHomeAppIcon } from './HomeAppIcon.types';

declare class HomeAppIconModule extends NativeModule {
  setIcon(icon: NativeHomeAppIcon): boolean;
}

export default requireNativeModule<HomeAppIconModule>('HomeAppIcon');
