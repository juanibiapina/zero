import { describe, expect, it } from '@jest/globals';
import { PromptModel, RecordingModel } from '@zero/agent-core';
import { createMergeableStore } from 'tinybase';

import { NOTHING_LEFT, PROMPT_READY, speakable, startHandsFree, type HandsFreeKey } from '@/lib/hands-free';

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
  let chimed: (() => void) | null = null;

  const session = startHandsFree({
    keys: { onKey: (listener) => { press = listener; return () => { press = () => {}; }; } },
    speech: {
      say: (text) => new Promise((resolve) => { spoken.push(text); speaking = resolve; }),
      stop: () => { speaking?.('stopped'); speaking = null; },
    },
    chime: () => new Promise((resolve) => { chimed = resolve; }),
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
    async finishChime() {
      chimed?.();
      chimed = null;
      await flush();
    },
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

async function started(seed: Record<string, PromptInput> = {}) {
  const h = harness(seed);
  await h.finishChime();
  return h;
}

async function heard(seed: Record<string, PromptInput>) {
  const h = await started(seed);
  await h.press('up');
  return h;
}

const flight: PromptInput = { title: 'Which flight?', text: 'Two flights fit.', suggestions: ['The 9:40', 'The 14:05'] };
const hotel: PromptInput = { title: 'Which hotel?', text: 'Pick one.', suggestions: ['The one by the beach'] };
const open: PromptInput = { title: 'Anything else?', text: 'Tell me more.', suggestions: [] };

describe('Hands-free', () => {
  it('chimes, then announces the oldest unanswered Prompt without reading it', async () => {
    const h = harness({ flight, hotel });
    await flush();
    expect(h.spoken).toEqual([]);
    await h.finishChime();
    expect(h.spoken).toEqual([PROMPT_READY]);
    expect(h.session.state()).toMatchObject({ phase: 'ready', prompt: { id: 'flight' } });
    await h.finishSpeaking();
    expect(h.session.state()).toMatchObject({ phase: 'ready', prompt: { id: 'flight' } });
    expect(h.prompts.get('flight')?.seenAt).toBeNull();
  });

  it('reads the Prompt on volume up, marks it read, and names the volume up answer', async () => {
    const h = await started({ flight, hotel });
    await h.press('up');
    expect(h.lastSaid()).toBe('Which flight?.\nTwo flights fit.\nVolume up: The 9:40.');
    expect(h.session.state()).toMatchObject({ phase: 'reading', prompt: { id: 'flight' } });
    expect(h.prompts.get('flight')?.seenAt).not.toBeNull();
    expect(h.prompts.get('flight')?.answer).toBeNull();
    await h.finishSpeaking();
    expect(h.session.state().phase).toBe('waiting');
  });

  it('records a plain note on volume down before a Prompt is read, and keeps the Prompt waiting', async () => {
    const h = await started({ flight });
    await h.press('down');
    expect(h.lastSaid()).toBe('Speak your note.');
    await h.finishSpeaking();
    await h.press('down');
    expect(h.recordings.list()).toEqual([expect.not.objectContaining({ promptId: expect.anything() })]);
    expect(h.prompts.get('flight')?.seenAt).toBeNull();
    expect(h.lastSaid()).toBe(`Note saved.\n${PROMPT_READY}`);
    expect(h.session.state()).toMatchObject({ phase: 'ready', prompt: { id: 'flight' } });
  });

  it('answers with the first suggestion on accept, even while still reading, and announces the next Prompt', async () => {
    const h = await heard({ flight, hotel });
    await h.press('up');
    expect(h.prompts.get('flight')?.answer?.text).toBe('The 9:40');
    expect(h.lastSaid()).toBe(`Answered: The 9:40.\n${PROMPT_READY}`);
    expect(h.session.state()).toMatchObject({ phase: 'ready', prompt: { id: 'hotel' } });
  });

  it('skips a Prompt without suggestions on accept and leaves it unanswered', async () => {
    const h = await heard({ open });
    expect(h.lastSaid()).toBe('Anything else?.\nTell me more.');
    await h.press('up');
    expect(h.prompts.get('open')?.answer).toBeNull();
    expect(h.lastSaid()).toBe(`Skipped.\n${NOTHING_LEFT}`);
  });

  it('records a spoken answer as a Recording for the Prompt and takes the Prompt out of the queue', async () => {
    const h = await heard({ flight, hotel });
    await h.press('down');
    expect(h.lastSaid()).toBe('Speak your answer.');
    expect(h.recording).toBe(false);
    await h.finishSpeaking();
    expect(h.session.state()).toMatchObject({ phase: 'recording', prompt: { id: 'flight' } });
    expect(h.recording).toBe(true);

    await h.press('up');
    expect(h.recording).toBe(false);
    expect(h.recordings.list()).toEqual([expect.objectContaining({ promptId: 'flight', durationMs: 4_000, device: 'Pixel 10 Pro', source: 'app' })]);
    expect(h.audio).toEqual(['file:///take.m4a']);
    expect(h.prompts.get('flight')?.answer).toBeNull();
    expect(h.lastSaid()).toBe(`Answer saved.\n${PROMPT_READY}`);
  });

  it('records a plain note when no Prompts are left, and accept ends the session', async () => {
    const h = await started();
    expect(h.lastSaid()).toBe(NOTHING_LEFT);
    await h.press('down');
    expect(h.lastSaid()).toBe('Speak your note.');
    await h.finishSpeaking();
    await h.press('down');
    expect(h.recordings.list()).toEqual([expect.not.objectContaining({ promptId: expect.anything() })]);
    expect(h.lastSaid()).toBe(`Note saved.\n${NOTHING_LEFT}`);

    await h.press('up');
    expect(h.session.state().phase).toBe('ended');
    expect(h.ended).toBe(true);
  });

  it('announces a Prompt that arrives while it waits with none left', async () => {
    const h = await started();
    await h.finishSpeaking();
    h.prompts.create('flight', flight);
    await flush();
    expect(h.lastSaid()).toBe(`New prompt.\n${PROMPT_READY}`);
    expect(h.session.state()).toMatchObject({ phase: 'ready', prompt: { id: 'flight' } });
  });

  it('moves on when the Prompt it waits on is answered on another device', async () => {
    const h = await started({ flight, hotel });
    await h.finishSpeaking();
    h.prompts.answer('flight', 'The 14:05');
    await flush();
    expect(h.session.state().prompt?.id).toBe('hotel');
  });

  it('cancels a spoken answer when a key is pressed before the microphone opens', async () => {
    const h = await heard({ flight });
    await h.finishSpeaking();
    await h.press('down');
    expect(h.session.state().phase).toBe('cue');
    await h.press('up');
    expect(h.lastSaid()).toBe('Cancelled.');
    await h.finishSpeaking();
    expect(h.session.state()).toMatchObject({ phase: 'waiting', prompt: { id: 'flight' } });
    expect(h.recording).toBe(false);
    expect(h.recordings.list()).toEqual([]);
    expect(h.prompts.get('flight')?.answer).toBeNull();
  });

  it('saves a recording in progress when stopped, then ignores keys', async () => {
    const h = await heard({ flight });
    await h.press('down');
    await h.finishSpeaking();
    await h.session.stop();
    expect(h.recordings.list()).toHaveLength(1);
    expect(h.ended).toBe(true);
    const said = h.spoken.length;
    await h.press('up');
    expect(h.spoken).toHaveLength(said);
    expect(h.prompts.get('flight')?.answer).toBeNull();
  });

  it('reads the first Prompt when volume up is pressed during the chime', async () => {
    const h = harness({ flight, hotel });
    await h.press('up');
    expect(h.lastSaid()).toMatch(/^Which flight\?/);
    await h.finishChime();
    expect(h.spoken).toHaveLength(1);
    expect(h.prompts.get('flight')?.answer).toBeNull();
  });

  it('ends on the stop key from the notification', async () => {
    const h = await started({ flight });
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
