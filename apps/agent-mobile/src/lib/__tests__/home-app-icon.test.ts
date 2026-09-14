import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';

import {
  homeAppIconForTaskCount,
  syncHomeAppIcon,
  type HomeAppIcon,
} from '../home-app-icon';

const mockSetAppIcon = jest.fn<(icon: string) => boolean>();
jest.mock('../../../modules/home-app-icon', () => ({
  setHomeAppIcon: (icon: string) => mockSetAppIcon(icon),
}));

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  mockSetAppIcon.mockReset();
  mockSetAppIcon.mockReturnValue(true);
});

describe('homeAppIconForTaskCount', () => {
  it.each<[number, HomeAppIcon]>([
    [0, null],
    [1, 'OneTask'],
    [2, 'TwoTasks'],
    [3, 'ThreeTasks'],
    [4, 'FourPlusTasks'],
    [5, 'FourPlusTasks'],
  ])('maps %i visible Home tasks to %s', (count, icon) => {
    expect(homeAppIconForTaskCount(count)).toBe(icon);
  });
});

describe('syncHomeAppIcon', () => {
  it('queues the matching launcher alias for the background transition', async () => {
    await syncHomeAppIcon('OneTask');

    expect(mockSetAppIcon).toHaveBeenCalledWith('OneTask');
  });

  it('does nothing outside Android', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });

    await syncHomeAppIcon('OneTask');

    expect(mockSetAppIcon).not.toHaveBeenCalled();
  });

  it('warns without throwing when Android rejects an icon', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSetAppIcon.mockReturnValue(false);

    await expect(syncHomeAppIcon('OneTask')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Could not update the Home task-count launcher icon.',
    );
    warn.mockRestore();
  });

  it('warns without throwing when the native call rejects', async () => {
    const error = new Error('native unavailable');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSetAppIcon.mockImplementation(() => {
      throw error;
    });

    await expect(syncHomeAppIcon('OneTask')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Could not update the Home task-count launcher icon.',
      error,
    );
    warn.mockRestore();
  });
});
