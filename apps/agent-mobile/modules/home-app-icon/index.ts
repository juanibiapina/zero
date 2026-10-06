import { requireOptionalNativeModule } from 'expo';

export type HomeAppIcon =
  | 'Default'
  | 'Empty'
  | 'OneTask'
  | 'TwoTasks'
  | 'ThreeTasks'
  | 'FourPlusTasks';

type NativeHomeAppIcon = {
  setIcon(icon: HomeAppIcon): boolean;
};

const native = typeof requireOptionalNativeModule === 'function'
  ? requireOptionalNativeModule<NativeHomeAppIcon>('HomeAppIcon')
  : null;

export function setHomeAppIcon(icon: HomeAppIcon): boolean {
  return native ? native.setIcon(icon) : true;
}
