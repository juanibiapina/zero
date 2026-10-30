import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defaultToastController, RecordingModel, type Recording } from '@zero/agent-core';
import { Stack } from 'expo-router';
import { createMergeableStore } from 'tinybase';
import { act, fireEvent, renderRouter, waitFor } from 'expo-router/testing-library';
import { Vibration } from 'react-native';

import HomeScreen from '@/app/(todo)/index';
import BrowseLayout from '@/app/(todo)/browse/_layout';
import BrowseScreen from '@/app/(todo)/browse/index';
import RecordPage from '@/app/(todo)/browse/record';
import RecordingsPage from '@/app/(todo)/browse/recordings';
import { Toaster } from '@/components/toaster';
import { createInMemoryTodoData, InMemoryTodoDataProvider } from '@/testing/in-memory-todo-data';
import type { Microphone } from '../../../modules/headset-mic';

type FinishEvent = { id: string; isFinished: boolean; hasError: boolean; error: string | null; url: string | null };

const mockAudio = {
  micGranted: true,
  listener: null as ((event: FinishEvent) => void) | null,
  recorder: null as null | Record<string, unknown>,
  player: null as null | { playing: boolean; source: unknown; listeners: Set<() => void> },
};
const mockFiles = new Set<string>();

const PHONE: Microphone = { name: 'Pixel 7', kind: 'phone' };
const mockMic = {
  headset: false,
  released: 0,
  canReport: true,
  reportOnRecord: PHONE as Microphone | null | 'nothing',
  listener: null as ((mic: Microphone | null) => void) | null,
};

jest.mock('../../../modules/headset-mic', () => ({
  routeToHeadset: async () => (mockMic.headset ? { release: () => { mockMic.released += 1; } } : null),
  watchRecordingInput: (onInput: (mic: Microphone | null) => void) => {
    if (!mockMic.canReport) return null;
    mockMic.listener = onInput;
    return () => { mockMic.listener = null; };
  },
}));

function report(mic: Microphone | null) {
  mockMic.listener?.(mic);
}

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
  mockMic.headset = false;
  mockMic.released = 0;
  mockMic.canReport = true;
  mockMic.reportOnRecord = PHONE;
  mockMic.listener = null;
  jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {}).mockClear();
  mockAudio.micGranted = true;
  mockFiles.clear();
  mockAudio.recorder = {
    prepareToRecordAsync: async () => {},
    record: () => {
      mockFiles.add(RECORDED);
      if (mockMic.reportOnRecord !== 'nothing') report(mockMic.reportOnRecord);
    },
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
      transcript: null,
    }]);
    expect([...mockFiles]).toEqual(['file:///documents/recordings/rec-1.m4a']);
    await waitFor(() => screen.getByText('Saved · 0:42'));

    await fireEvent.press(screen.getByText('View'));
    await waitFor(() => expect(result.getPathname()).toBe('/browse/recordings'));
    // The row shows the time in the device time zone, so match the only saved note without pinning the hour.
    expect(screen.getByLabelText(/^Play recording from \w{3} \d{1,2} Oct, \d{2}:30$/)).toBeTruthy();
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

describe('Microphone', () => {
  it('invites speech only once Android reports that the microphone is capturing', async () => {
    mockMic.reportOnRecord = 'nothing';
    const { screen } = await open('/browse/record?source=app');
    await waitFor(() => screen.getByText('Getting the microphone ready…'));
    expect(screen.queryByText('0:00')).toBeNull();
    expect(Vibration.vibrate).not.toHaveBeenCalled();

    await act(async () => { report({ name: 'Pixel Buds Pro', kind: 'bluetooth' }); });
    expect(screen.getByText('Recording')).toBeTruthy();
    expect(screen.getByText('0:00')).toBeTruthy();
    expect(screen.getByText('Pixel Buds Pro · Bluetooth headset')).toBeTruthy();
    expect(Vibration.vibrate).toHaveBeenCalledTimes(1);
  });

  it('names the phone microphone when no headset is connected', async () => {
    const { screen } = await open('/browse/record?source=app');
    await waitFor(() => screen.getByText('Pixel 7 · Phone microphone'));
  });

  it('shows the kind alone when Android gives no name, and Microphone when it names no device', async () => {
    mockMic.reportOnRecord = { name: null, kind: 'bluetooth-le' };
    const { screen } = await open('/browse/record?source=app');
    await waitFor(() => screen.getByText('Bluetooth LE headset'));
    await act(async () => { report(null); });
    expect(screen.getByText('Microphone')).toBeTruthy();
  });

  it('follows the input when the headset drops mid-recording', async () => {
    mockMic.headset = true;
    mockMic.reportOnRecord = { name: 'Pixel Buds Pro', kind: 'bluetooth' };
    const { screen } = await open('/browse/record?source=app');
    await waitFor(() => screen.getByText('Pixel Buds Pro · Bluetooth headset'));
    await act(async () => { report(PHONE); });
    expect(screen.getByText('Pixel 7 · Phone microphone')).toBeTruthy();
    expect(Vibration.vibrate).toHaveBeenCalledTimes(1);
  });

  it('gives the headset back once the voice note is saved', async () => {
    mockMic.headset = true;
    const { screen, data } = await open('/browse/record?source=app');
    await waitFor(() => screen.getByText('Recording'));
    expect(mockMic.released).toBe(0);
    await fireEvent.press(screen.getByLabelText('Stop and save'));
    await waitFor(() => expect(saved(data)).toHaveLength(1));
    expect(mockMic.released).toBe(1);
  });

  it('starts at once and says Microphone where the phone cannot report its input', async () => {
    mockMic.canReport = false;
    const { screen } = await open('/browse/record?source=app');
    await waitFor(() => screen.getByText('Recording'));
    expect(screen.getByText('Microphone')).toBeTruthy();
  });
});

describe('Recordings', () => {
  const berlin: Recording = { id: 'b', startedAt: '2026-10-20T18:30:00.000Z', timeZone: 'Europe/Berlin', durationMs: 42_000, source: 'widget', device: 'Pixel 7', transcript: null };
  const newYork: Recording = { id: 'n', startedAt: '2026-10-21T01:00:00.000Z', timeZone: 'America/New_York', durationMs: 75_000, source: 'app', device: 'Pixel 9', transcript: null };
  const transcribe = (data: Awaited<ReturnType<typeof open>>['data'], id: string, text: string, title = '') => act(async () => {
    new RecordingModel(data.replica!.store).setTranscript(id, { text, verbatim: text, title, model: 'm', transcribedAt: '2026-10-20T18:31:00.000Z' });
  });

  it('lists each voice note by its title over its date once the transcript arrives, and says so while it is on its way', async () => {
    mockFiles.add('file:///documents/recordings/b.m4a');
    const { screen, data } = await open('/browse/recordings', [berlin, newYork]);
    expect(screen.getByText('Transcribing…')).toBeTruthy();

    await transcribe(data, 'b', 'Call Ana on Friday about the party.', 'Call Ana about the party');
    await transcribe(data, 'n', 'Buy grout.', 'Buy grout');

    expect(screen.queryByText('Transcribing…')).toBeNull();
    expect(screen.getByText('Call Ana about the party')).toBeTruthy();
    expect(screen.getByText('Buy grout')).toBeTruthy();
    expect(screen.getByText('Tue 20 Oct, 20:30')).toBeTruthy();
    expect(screen.queryByText('Call Ana on Friday about the party.')).toBeNull();
    expect(screen.getByLabelText('Call Ana about the party. Play recording from Tue 20 Oct, 20:30')).toBeTruthy();
  });

  it('lists a voice note transcribed before titles existed by its date alone', async () => {
    const { screen, data } = await open('/browse/recordings', [newYork]);
    await transcribe(data, 'n', 'Buy grout.');
    expect(screen.getByLabelText('Recording from Tue 20 Oct, 21:00, on Pixel 9')).toBeTruthy();
    expect(screen.getByText('Tue 20 Oct, 21:00')).toBeTruthy();
    expect(screen.queryByText('Buy grout.')).toBeNull();
  });

  it('says No speech for a silent voice note', async () => {
    mockFiles.add('file:///documents/recordings/b.m4a');
    const { screen, data } = await open('/browse/recordings', [berlin]);
    await transcribe(data, 'b', '');
    expect(screen.getByText('No speech')).toBeTruthy();
  });

  it('shows the title, date and whole transcript when a voice note is held', async () => {
    const long = 'First thought. '.repeat(40).trim();
    const { screen, data } = await open('/browse/recordings', [newYork]);
    await transcribe(data, 'n', long, 'First thoughts');
    await fireEvent(screen.getByLabelText('First thoughts. Recording from Tue 20 Oct, 21:00, on Pixel 9'), 'longPress');
    expect(screen.getAllByText('First thoughts')).toHaveLength(2);
    expect(screen.getAllByText('Tue 20 Oct, 21:00')).toHaveLength(2);
    expect(screen.getByText(long)).toBeTruthy();
  });

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
