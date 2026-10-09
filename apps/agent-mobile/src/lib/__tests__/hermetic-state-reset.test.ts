import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resetHermeticTodoState } from '../hermetic-state-reset';

const mockMultiRemove = jest.fn<(keys: string[]) => Promise<void>>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  multiRemove: (keys: string[]) => mockMultiRemove(keys),
}));
jest.mock('../runtime-profile', () => ({
  RUNTIME_PROFILE: {
    hermetic: true,
    storageKeys: {
      todoWorkspaceKey: 'workspace',
      timezoneKey: 'timezone',
      iconSuggestionsKey: 'icons',
    },
  },
}));

describe('hermetic state reset', () => {
  beforeEach(() => {
    mockMultiRemove.mockReset().mockResolvedValue();
  });

  it('removes only isolated metadata while the harness owns exact database cleanup', async () => {
    await resetHermeticTodoState();

    expect(mockMultiRemove).toHaveBeenCalledWith([
      'workspace', 'timezone', 'icons', 'zero.e2e.project-section-folds.v1',
    ]);
  });
});
