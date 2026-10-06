import { requireOptionalNativeModule } from 'expo';

import type icons from './icons.json';

export type HomeAppIcon = 'Default' | keyof typeof icons;

type NativeHomeAppIcon = {
  setIcon(icon: HomeAppIcon): boolean;
};

const native = typeof requireOptionalNativeModule === 'function'
  ? requireOptionalNativeModule<NativeHomeAppIcon>('HomeAppIcon')
  : null;

export function setHomeAppIcon(icon: HomeAppIcon): boolean {
  return native ? native.setIcon(icon) : true;
}
