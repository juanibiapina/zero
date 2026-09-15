import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import { AppState, Text, View } from 'react-native';

import { useLocalDay } from '@/lib/local-day';

function DayProbe() {
  return <Text>{useLocalDay()}</Text>;
}

describe('useLocalDay', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });
  afterAll(() => {
    jest.useRealTimers();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('publishes the day at active midnight and after a missed background rollover', async () => {
    jest.setSystemTime(new Date(2026, 8, 15, 23, 59, 59, 900));
    const appStateSpy = jest.spyOn(AppState, 'addEventListener');

    const screen = await render(
      <View>
        <DayProbe />
        <DayProbe />
      </View>,
    );
    expect(screen.getAllByText('2026-09-15')).toHaveLength(2);
    expect(appStateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(200);
    });

    expect(screen.getAllByText('2026-09-16')).toHaveLength(2);

    jest.setSystemTime(new Date(2026, 8, 18, 8));
    const onAppStateChange = appStateSpy.mock.calls.at(-1)?.[1] as
      | ((state: string) => void)
      | undefined;
    expect(onAppStateChange).toBeDefined();

    await act(async () => {
      onAppStateChange?.('active');
    });
    // react-test-renderer does not flush a synchronous useSyncExternalStore
    // notification. Advancing to the next local midnight verifies that the
    // foreground event rescheduled the shared timer from the current clock.
    await act(async () => {
      jest.advanceTimersByTime(16 * 60 * 60 * 1000 + 2);
    });

    expect(screen.getAllByText('2026-09-19')).toHaveLength(2);
    await screen.unmount();
  });
});
