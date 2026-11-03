import { describe, expect, it } from '@jest/globals';
import { PromptModel, RecordingModel } from '@zero/agent-core';
import { createMergeableStore } from 'tinybase';

import { NOTHING_LEFT, speakable, startHandsFree, type HandsFreeKey } from '@/lib/hands-free';

type PromptInput = Parameters<PromptModel['create']>[1];

const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });

function harness(seed: Record<string, PromptInput> = {}) {
  const store = createMergeableStore();
  let clock = Date.parse('2026-11-03T19:00:00.000Z');
  const tick = () => new Date((clock += 60_000));
  const prompts = new PromptModel(store, tick);
  const recordings = new RecordingModel(store);
  for (const [id, input] of Object.entries(seed)) prompts.create(id, input);

  const spoken: string[] = [];
  let speaking: ((outcome: 'done' | 'stopped') => void) | null = null;
  let press: (key: HandsFreeKey) => void = () => {};
  const audio: string[] = [];
  let recording = false;
  let ended = false;

  const session = startHandsFree({
    keys: { onKey: (listener) => { press = listener; return () => { press = () => {}; }; } },
    speech: {
      say: (text) => new Promise((resolve) => { spoken.push(text); speaking = resolve; }),
      stop: () => { speaking?.('stopped'); speaking = null; },
    },
    recorder: {
      start: async () => { recording = true; },
      finish: async () => {
        if (!recording) return null;
        recording = false;
        return { uri: 'file:///take.m4a', durationMs: 4_000 };
      },
      ready: () => {},
    },
    data: {
      snapshot: () => ({ prompts: prompts.list(), recordings: recordings.list() }),
      subscribe: (listener) => {
        const id = store.addTablesListener(() => listener());
        return () => { store.delListener(id); };
      },
      markSeen: async (id) => { prompts.markSeen(id); },
      answer: async (id, text) => {
        const result = prompts.answer(id, text);
        if (!result.ok) throw new Error(result.conflict);
      },
      saveRecording: async (uri, recording) => { audio.push(uri); recordings.add(recording); },
    },
    newId: () => `r${recordings.list().length + 1}`,
    device: 'Pixel 10 Pro',
    now: () => new Date(clock),
    onEnd: () => { ended = true; },
  });

  return {
    session,
    prompts,
    recordings,
    store,
    audio,
    spoken,
    lastSaid: () => spoken[spoken.length - 1],
    get ended() { return ended; },
    get recording() { return recording; },
    async finishSpeaking() {
      speaking?.('done');
      speaking = null;
      await flush();
    },
    async press(key: HandsFreeKey) {
      press(key);
      await flush();
    },
  };
}

const flight: PromptInput = { title: 'Which flight?', text: 'Two flights fit.', suggestions: ['The 9:40', 'The 14:05'] };
const hotel: PromptInput = { title: 'Which hotel?', text: 'Pick one.', suggestions: ['The one by the beach'] };
const open: PromptInput = { title: 'Anything else?', text: 'Tell me more.', suggestions: [] };

describe('Hands-free', () => {
  it('reads the oldest unanswered Prompt first, marks it read, and says what the keys do', async () => {
    const h = harness({ flight, hotel });
    expect(h.lastSaid()).toBe('Hands-free on.\nWhich flight?.\nTwo flights fit.\nVolume up: The 9:40. Volume down: speak your answer.');
    expect(h.session.state()).toMatchObject({ phase: 'reading', prompt: { id: 'flight' } });
    await flush();
    expect(h.prompts.get('flight')?.seenAt).not.toBeNull();
    await h.finishSpeaking();
    expect(h.session.state().phase).toBe('waiting');
  });

  it('answers with the first suggestion on accept, even while still reading, and moves on', async () => {
    const h = harness({ flight, hotel });
    await h.press('accept');
    expect(h.prompts.get('flight')?.answer?.text).toBe('The 9:40');
    expect(h.lastSaid()).toMatch(/^Answered: The 9:40\.\nWhich hotel\?/);
    expect(h.session.state().prompt?.id).toBe('hotel');
  });

  it('skips a Prompt without suggestions on accept and leaves it unanswered', async () => {
    const h = harness({ open });
    expect(h.lastSaid()).toContain('Volume up skips it.');
    await h.press('accept');
    expect(h.prompts.get('open')?.answer).toBeNull();
    expect(h.lastSaid()).toBe(`Skipped.\n${NOTHING_LEFT}`);
  });

  it('records a spoken answer as a Recording for the Prompt and takes the Prompt out of the queue', async () => {
    const h = harness({ flight, hotel });
    await h.press('speak');
    expect(h.lastSaid()).toBe('Speak your answer.');
    expect(h.recording).toBe(false);
    await h.finishSpeaking();
    expect(h.session.state()).toMatchObject({ phase: 'recording', prompt: { id: 'flight' } });
    expect(h.recording).toBe(true);

    await h.press('accept');
    expect(h.recording).toBe(false);
    expect(h.recordings.list()).toEqual([expect.objectContaining({ promptId: 'flight', durationMs: 4_000, device: 'Pixel 10 Pro', source: 'app' })]);
    expect(h.audio).toEqual(['file:///take.m4a']);
    expect(h.prompts.get('flight')?.answer).toBeNull();
    expect(h.lastSaid()).toMatch(/^Answer saved\.\nWhich hotel\?/);
  });

  it('records a plain note when no Prompts are left, and accept ends the session', async () => {
    const h = harness();
    expect(h.lastSaid()).toBe(`Hands-free on.\n${NOTHING_LEFT}`);
    await h.press('speak');
    expect(h.lastSaid()).toBe('Speak your note.');
    await h.finishSpeaking();
    await h.press('speak');
    expect(h.recordings.list()).toEqual([expect.not.objectContaining({ promptId: expect.anything() })]);
    expect(h.lastSaid()).toBe(`Note saved.\n${NOTHING_LEFT}`);

    await h.press('accept');
    expect(h.session.state().phase).toBe('ended');
    expect(h.ended).toBe(true);
  });

  it('reads a Prompt that arrives while it waits with none left', async () => {
    const h = harness();
    await h.finishSpeaking();
    h.prompts.create('flight', flight);
    await flush();
    expect(h.lastSaid()).toMatch(/^New prompt\.\nWhich flight\?/);
  });

  it('moves on when the Prompt it waits on is answered on another device', async () => {
    const h = harness({ flight, hotel });
    await h.finishSpeaking();
    h.prompts.answer('flight', 'The 14:05');
    await flush();
    expect(h.session.state().prompt?.id).toBe('hotel');
  });

  it('repeats the current Prompt', async () => {
    const h = harness({ flight });
    await h.finishSpeaking();
    await h.press('repeat');
    expect(h.lastSaid()).toMatch(/^Which flight\?/);
  });

  it('saves a recording in progress when stopped, then ignores keys', async () => {
    const h = harness({ flight });
    await h.press('speak');
    await h.finishSpeaking();
    await h.session.stop();
    expect(h.recordings.list()).toHaveLength(1);
    expect(h.ended).toBe(true);
    const said = h.spoken.length;
    await h.press('accept');
    expect(h.spoken).toHaveLength(said);
    expect(h.prompts.get('flight')?.answer).toBeNull();
  });

  it('ends on the stop key from the notification', async () => {
    const h = harness({ flight });
    await h.press('stop');
    expect(h.session.state().phase).toBe('ended');
  });
});

describe('speakable', () => {
  it('reads Markdown as plain sentences and skips code and diagrams', () => {
    expect(speakable([
      '## Options',
      '- **Fast**: see [the docs](https://example.com) or https://example.com/x',
      '- Use `zero vault`',
      '',
      '```mermaid',
      'graph TD; A-->B',
      '```',
      '',
      '```ts',
      'const a = 1;',
      '```',
    ].join('\n'))).toBe('Options\nFast: see the docs or link\nUse zero vault\nDiagram skipped.\nCode skipped.');
  });
});
