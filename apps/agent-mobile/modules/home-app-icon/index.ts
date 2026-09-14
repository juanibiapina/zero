import { Platform } from 'react-native';

import HomeAppIconModule from './src/HomeAppIconModule';
import type { NativeHomeAppIcon } from './src/HomeAppIcon.types';

export function setHomeAppIcon(icon: NativeHomeAppIcon): boolean {
  if (Platform.OS !== 'android') return true;
  return HomeAppIconModule.setIcon(icon);
}

export type { NativeHomeAppIcon } from './src/HomeAppIcon.types';
