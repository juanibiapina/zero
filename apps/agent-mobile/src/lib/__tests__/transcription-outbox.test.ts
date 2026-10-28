import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Recording, Transcript } from '@zero/agent-core';

import { startTranscriptionOutbox, type TranscriptionUpload } from '../transcription-outbox';

const transcript: Transcript = { text: 'Hi.', verbatim: 'Hi.', model: 'm', transcribedAt: '2026-10-20T18:31:00.000Z' };

const recording = (id: string, overrides: Partial<Recording> = {}): Recording => ({
  id,
  startedAt: '2026-10-20T18:30:00.000Z',
  timeZone: 'Europe/Berlin',
  durationMs: 1_000,
  source: 'app',
  device: 'Pixel 7',
  transcript: null,
  title: null,
  ...overrides,
});

type Outcome = TranscriptionUpload | Promise<TranscriptionUpload> | Error;

function setup(initial: Recording[], onDisk: string[], outcomes: Outcome[] = []) {
  let recordings = initial;
  const listeners = new Set<() => void>();
  const resumers = new Set<() => void>();
  const upload = jest.fn(async (_id: string, _uri: string): Promise<TranscriptionUpload> => {
    const outcome = outcomes.shift() ?? 'done';
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const stop = startTranscriptionOutbox({
    replica: {
      snapshot: () => ({ recordings }),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    localAudio: (id) => (onDisk.includes(id) ? `file:///recordings/${id}.m4a` : null),
    upload,
    onResume: (resume) => { resumers.add(resume); return () => resumers.delete(resume); },
    retryDelaysMs: [2_000, 5_000],
  });
  return {
    upload,
    stop,
    change: (next: Recording[]) => { recordings = next; listeners.forEach((listener) => listener()); },
    resume: () => resumers.forEach((resume) => resume()),
  };
}

const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const uploaded = (upload: ReturnType<typeof setup>['upload']) => upload.mock.calls.map(([id]) => id);

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('transcription outbox', () => {
  it('sends each voice note whose audio is on this phone and has no transcript, once', async () => {
    const outbox = setup([recording('a'), recording('done', { transcript }), recording('elsewhere')], ['a', 'done']);
    await settle();
    expect(uploaded(outbox.upload)).toEqual(['a']);
    expect(outbox.upload).toHaveBeenCalledWith('a', 'file:///recordings/a.m4a');

    outbox.change([recording('a'), recording('done', { transcript }), recording('elsewhere')]);
    await settle();
    expect(uploaded(outbox.upload)).toEqual(['a']);
  });

  it('sends a new voice note as soon as it is saved', async () => {
    const outbox = setup([], ['new']);
    await settle();
    outbox.change([recording('new')]);
    await settle();
    expect(uploaded(outbox.upload)).toEqual(['new']);
  });

  it('sends one voice note at a time', async () => {
    let finish!: (outcome: TranscriptionUpload) => void;
    const first = new Promise<TranscriptionUpload>((resolve) => { finish = resolve; });
    const outbox = setup([recording('a'), recording('b')], ['a', 'b'], [first]);
    await settle();
    outbox.change([recording('a'), recording('b')]);
    await settle();
    expect(uploaded(outbox.upload)).toEqual(['a']);
    finish('done');
    await settle();
    expect(uploaded(outbox.upload)).toEqual(['a', 'b']);
  });

  it('tries again shortly while the server has not received the voice note, then waits for the app to return', async () => {
    const outbox = setup([recording('a')], ['a'], ['not-synced', 'not-synced', 'not-synced']);
    await settle();
    expect(outbox.upload).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(outbox.upload).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(outbox.upload).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(outbox.upload).toHaveBeenCalledTimes(3);

    outbox.resume();
    await settle();
    expect(outbox.upload).toHaveBeenCalledTimes(4);
  });

  it('waits for the app to return or the connection to come back after a failure', async () => {
    const outbox = setup([recording('a')], ['a'], [new Error('offline'), 'later']);
    await settle();
    outbox.change([recording('a')]);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(outbox.upload).toHaveBeenCalledTimes(1);

    outbox.resume();
    await settle();
    expect(outbox.upload).toHaveBeenCalledTimes(2);
    outbox.resume();
    await settle();
    expect(outbox.upload).toHaveBeenCalledTimes(3);
  });

  it('sends nothing more once stopped', async () => {
    const outbox = setup([recording('a')], ['a'], ['not-synced']);
    await settle();
    outbox.stop();
    await jest.advanceTimersByTimeAsync(10_000);
    outbox.change([recording('a'), recording('b')]);
    outbox.resume();
    await settle();
    expect(outbox.upload).toHaveBeenCalledTimes(1);
  });
});
