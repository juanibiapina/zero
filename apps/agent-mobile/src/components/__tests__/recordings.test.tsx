import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defaultToastController, RecordingModel, type Recording } from '@zero/agent-core';
import { Stack } from 'expo-router';
import { createMergeableStore } from 'tinybase';
import { act, fireEvent, renderRouter, waitFor } from 'expo-router/testing-library';

import HomeScreen from '@/app/(todo)/index';
import BrowseLayout from '@/app/(todo)/browse/_layout';
import BrowseScreen from '@/app/(todo)/browse/index';
import RecordPage from '@/app/(todo)/browse/record';
import RecordingsPage from '@/app/(todo)/browse/recordings';
import { Toaster } from '@/components/toaster';
import { createInMemoryTodoData, InMemoryTodoDataProvider } from '@/testing/in-memory-todo-data';

type FinishEvent = { id: string; isFinished: boolean; hasError: boolean; error: string | null; url: string | null };

const mockAudio = {
  micGranted: true,
  listener: null as ((event: FinishEvent) => void) | null,
  recorder: null as null | Record<string, unknown>,
  player: null as null | { playing: boolean; source: unknown; listeners: Set<() => void> },
};
const mockFiles = new Set<string>();

jest.mock('expo-audio', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const playing = { playing: true, didJustFinish: false };
  const paused = { playing: false, didJustFinish: false };
  return {
    AudioQuality: { MEDIUM: 64 },
    requestRecordingPermissionsAsync: async () => ({ granted: mockAudio.micGranted }),
    requestNotificationPermissionsAsync: async () => ({ granted: true }),
    setAudioModeAsync: async () => {},
    useAudioRecorder: (_options: unknown, listener: (event: FinishEvent) => void) => {
      mockAudio.listener = listener;
      return mockAudio.recorder;
    },
    useAudioRecorderState: () => ({ durationMillis: 0 }),
    useAudioPlayer: () => mockAudio.player,
    useAudioPlayerStatus: (player: NonNullable<typeof mockAudio.player>) => React.useSyncExternalStore(
      (listener: () => void) => { player.listeners.add(listener); return () => player.listeners.delete(listener); },
      () => (player.playing ? playing : paused),
    ),
  };
});

jest.mock('expo-file-system', () => {
  const uriOf = (parts: unknown[]) => parts.map((part) => (typeof part === 'string' ? part : (part as { uri: string }).uri)).join('/');
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = uriOf(parts); }
    create() {}
  }
  class File {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = uriOf(parts); }
    get exists() { return mockFiles.has(this.uri); }
    moveSync(destination: File) { mockFiles.delete(this.uri); mockFiles.add(destination.uri); }
    delete() { mockFiles.delete(this.uri); }
  }
  return { Directory, File, Paths: { document: new Directory('file:///documents') } };
});

jest.mock('expo-device', () => ({ modelName: 'Pixel 7' }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'rec-1' }));
jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: async () => 'token', signOut: async () => {} }),
  useUser: () => ({ user: null }),
}));
jest.mock('expo-router/build/testing-library/mocks', () => ({}));
jest.mock('react-native-safe-area-context', () => jest.requireActual<typeof import('react-native-safe-area-context/jest/mock')>('react-native-safe-area-context/jest/mock').default);

const RECORDED = 'file:///documents/Audio/recording-abc.m4a';

function finish(event: Partial<FinishEvent> = {}) {
  mockAudio.listener?.({ id: 'r', isFinished: true, hasError: false, error: null, url: RECORDED, ...event });
}

beforeEach(() => {
  mockAudio.micGranted = true;
  mockFiles.clear();
  mockAudio.recorder = {
    prepareToRecordAsync: async () => {},
    record: () => { mockFiles.add(RECORDED); },
    stop: async () => { finish(); },
  };
  const player = {
    playing: false,
    source: null as unknown,
    listeners: new Set<() => void>(),
    replace(source: unknown) { player.source = source; },
    play() { player.playing = true; player.listeners.forEach((listener) => listener()); },
    pause() { player.playing = false; player.listeners.forEach((listener) => listener()); },
  };
  mockAudio.player = player;
});

afterEach(() => {
  jest.useRealTimers();
  defaultToastController.dismiss();
});

async function open(initialUrl: string, recordings: Recording[] = []) {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'], now: new Date('2026-10-20T18:30:00Z') });
  const data = createInMemoryTodoData();
  for (const recording of recordings) await data.replica!.recordings.add(recording);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = renderRouter({
    _layout: () => <QueryClientProvider client={client}><InMemoryTodoDataProvider data={data}><Stack screenOptions={{ headerShown: false }} /><Toaster /></InMemoryTodoDataProvider></QueryClientProvider>,
    index: HomeScreen,
    'browse/_layout': BrowseLayout,
    'browse/index': BrowseScreen,
    'browse/record': RecordPage,
    'browse/recordings': RecordingsPage,
  }, { initialUrl });
  return { screen: await result, result, data };
}

const saved = (data: Awaited<ReturnType<typeof open>>['data']) => data.replica!.snapshot().recordings;

describe('Voice capture', () => {
  it('records from the Home mic and saves the file with when, where and how long', async () => {
    const { screen, result, data } = await open('/');
    await fireEvent.press(screen.getByLabelText('Record a voice note'));
    await waitFor(() => screen.getByText('Recording'));
    await act(async () => { jest.advanceTimersByTime(42_000); });
    await fireEvent.press(screen.getByLabelText('Stop and save'));

    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(saved(data)).toEqual([{
      id: 'rec-1',
      startedAt: '2026-10-20T18:30:00.000Z',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      durationMs: 42_000,
      source: 'app',
      device: 'Pixel 7',
    }]);
    expect([...mockFiles]).toEqual(['file:///documents/recordings/rec-1.m4a']);
    await waitFor(() => screen.getByText('Saved · 0:42'));
  });

  it('marks a recording started from the widget', async () => {
    const { screen, data } = await open('/browse/record?source=widget');
    await waitFor(() => screen.getByText('Recording'));
    await fireEvent.press(screen.getByLabelText('Stop and save'));
    await waitFor(() => expect(saved(data).map((recording) => recording.source)).toEqual(['widget']));
  });

  it('saves once when the notification stops the recording, even if Stop follows', async () => {
    const { screen, data } = await open('/browse/record?source=widget');
    await waitFor(() => screen.getByText('Recording'));
    await act(async () => { finish(); });
    await act(async () => { finish(); });
    await waitFor(() => expect(saved(data)).toHaveLength(1));
  });

  it('saves when Back leaves a recording', async () => {
    const { screen, result, data } = await open('/browse/record?source=app');
    await waitFor(() => screen.getByText('Recording'));
    await fireEvent.press(screen.getByLabelText('Back to Home'));
    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(saved(data)).toHaveLength(1);
  });

  it('asks for the microphone and records nothing without it', async () => {
    mockAudio.micGranted = false;
    const { screen, data } = await open('/browse/record?source=app');
    await waitFor(() => screen.getByText('Zero needs microphone access to record.'));
    expect(saved(data)).toEqual([]);
  });
});

describe('Recordings', () => {
  const berlin: Recording = { id: 'b', startedAt: '2026-10-20T18:30:00.000Z', timeZone: 'Europe/Berlin', durationMs: 42_000, source: 'widget', device: 'Pixel 7' };
  const newYork: Recording = { id: 'n', startedAt: '2026-10-21T01:00:00.000Z', timeZone: 'America/New_York', durationMs: 75_000, source: 'app', device: 'Pixel 9' };

  it('lists the newest first, each at its own local time', async () => {
    const { screen } = await open('/browse/recordings', [berlin, newYork]);
    const rows = screen.getAllByText(/Oct, /).map((node) => node.props.children);
    expect(rows).toEqual(['Tue 20 Oct, 21:00', 'Tue 20 Oct, 20:30']);
    expect(screen.getByText('1:15')).toBeTruthy();
  });

  it('plays a recording kept on this phone and pauses it on a second tap', async () => {
    mockFiles.add('file:///documents/recordings/b.m4a');
    const { screen } = await open('/browse/recordings', [berlin]);
    await fireEvent.press(screen.getByLabelText('Play recording from Tue 20 Oct, 20:30'));
    expect(mockAudio.player!.source).toEqual({ uri: 'file:///documents/recordings/b.m4a' });
    await fireEvent.press(screen.getByLabelText('Pause recording from Tue 20 Oct, 20:30'));
    expect(mockAudio.player!.playing).toBe(false);
  });

  it('names the phone that holds a recording made elsewhere', async () => {
    const { screen } = await open('/browse/recordings', [newYork]);
    expect(screen.getByText('On Pixel 9')).toBeTruthy();
    expect(screen.queryByLabelText(/^Play/)).toBeNull();
  });

  const holdAndDelete = async (screen: Awaited<ReturnType<typeof open>>['screen'], label: string) => {
    await fireEvent(screen.getByLabelText(label), 'longPress');
    await fireEvent.press(screen.getByText('Delete recording'));
  };

  it('deletes a recording made on this phone, with its audio, after asking', async () => {
    mockFiles.add('file:///documents/recordings/b.m4a');
    const { screen, data } = await open('/browse/recordings', [berlin]);
    await holdAndDelete(screen, 'Play recording from Tue 20 Oct, 20:30');
    expect(screen.getByText('Its audio is deleted and it leaves all your devices. This can’t be undone.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Delete'));
    await waitFor(() => expect(saved(data)).toEqual([]));
    expect(screen.getByText('No recordings yet.')).toBeTruthy();
    expect(mockFiles.has('file:///documents/recordings/b.m4a')).toBe(false);
  });

  it('keeps the recording and its audio when the delete is cancelled', async () => {
    mockFiles.add('file:///documents/recordings/b.m4a');
    const { screen, data } = await open('/browse/recordings', [berlin]);
    await holdAndDelete(screen, 'Play recording from Tue 20 Oct, 20:30');
    await fireEvent.press(screen.getByLabelText('Cancel'));
    expect(screen.queryByText('Delete recording?')).toBeNull();
    expect(saved(data)).toEqual([berlin]);
    expect(mockFiles.has('file:///documents/recordings/b.m4a')).toBe(true);
  });

  it('says a recording was made on another phone and deletes it anyway', async () => {
    const { screen, data } = await open('/browse/recordings', [newYork]);
    await fireEvent(screen.getByLabelText('Recording from Tue 20 Oct, 21:00, on Pixel 9'), 'longPress');
    expect(screen.getByText('Recorded on Pixel 9. Its audio isn’t on this phone.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Delete recording'));
    expect(screen.getByText('It leaves all your devices. Pixel 9 deletes its audio the next time it syncs.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Delete'));
    await waitFor(() => expect(saved(data)).toEqual([]));
  });

  it('deletes the audio here when another phone deletes the recording', async () => {
    mockFiles.add('file:///documents/recordings/b.m4a');
    const { data } = await open('/browse/recordings', [berlin]);
    const otherPhone = createMergeableStore();
    otherPhone.merge(data.replica!.store);
    new RecordingModel(otherPhone).remove('b');
    await act(async () => { data.replica!.store.merge(otherPhone); });
    expect(mockFiles.has('file:///documents/recordings/b.m4a')).toBe(false);
  });

  it('stops playing a recording when it is deleted', async () => {
    mockFiles.add('file:///documents/recordings/b.m4a');
    const { screen, data } = await open('/browse/recordings', [berlin]);
    await fireEvent.press(screen.getByLabelText('Play recording from Tue 20 Oct, 20:30'));
    await holdAndDelete(screen, 'Pause recording from Tue 20 Oct, 20:30');
    await fireEvent.press(screen.getByLabelText('Delete'));
    await waitFor(() => expect(saved(data)).toEqual([]));
    expect(mockAudio.player!.playing).toBe(false);
  });

  it('opens from Browse', async () => {
    const { screen, result } = await open('/browse');
    await fireEvent.press(screen.getByLabelText('Recordings'));
    expect(result.getPathname()).toBe('/browse/recordings');
    expect(screen.getByText('No recordings yet.')).toBeTruthy();
  });
});
