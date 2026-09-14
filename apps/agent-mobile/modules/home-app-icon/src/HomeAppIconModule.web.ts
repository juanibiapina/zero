import { NativeModule, registerWebModule } from 'expo';

import type { NativeHomeAppIcon } from './HomeAppIcon.types';

class HomeAppIconModule extends NativeModule {
  setIcon(_icon: NativeHomeAppIcon): boolean {
    return true;
  }
}

export default registerWebModule(HomeAppIconModule, 'HomeAppIcon');
