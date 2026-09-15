import { Platform } from 'react-native';

import { setHomeAppIcon } from '../../modules/home-app-icon';

export type HomeAppIcon =
  | 'Default'
  | 'Empty'
  | 'OneTask'
  | 'TwoTasks'
  | 'ThreeTasks'
  | 'FourPlusTasks';

export function homeAppIconForTaskCount(count: number): HomeAppIcon {
  if (count <= 0) return 'Empty';
  if (count === 1) return 'OneTask';
  if (count === 2) return 'TwoTasks';
  if (count === 3) return 'ThreeTasks';
  return 'FourPlusTasks';
}

const ICON_WARNING = 'Could not update the Home task-count launcher icon.';

export async function syncHomeAppIcon(icon: HomeAppIcon): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const result = setHomeAppIcon(icon);
    if (result === false) console.warn(ICON_WARNING);
  } catch (error) {
    console.warn(ICON_WARNING, error);
  }
}
