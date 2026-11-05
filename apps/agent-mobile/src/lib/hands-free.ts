import type { NewRecording, Prompt, Recording } from '@zero/agent-core';

export type HandsFreeKey = 'up' | 'down' | 'stop';

export type HandsFreePhase = 'ready' | 'reading' | 'waiting' | 'cue' | 'recording' | 'saving' | 'ended';

export type HandsFreeState = { phase: HandsFreePhase; prompt: Prompt | null };

export type HandsFreeTake = { uri: string; durationMs: number };

export type HandsFreePorts = {
  keys: { onKey: (listener: (key: HandsFreeKey) => void) => () => void };
  speech: { say: (text: string) => Promise<'done' | 'stopped'>; stop: () => void };
  chime: () => Promise<void>;
  recorder: { start: () => Promise<void>; finish: () => Promise<HandsFreeTake | null>; ready: () => void };
  data: {
    snapshot: () => { prompts: Prompt[]; recordings: Recording[] };
    subscribe: (listener: () => void) => () => void;
    markSeen: (id: string) => Promise<void>;
    answer: (id: string, text: string) => Promise<void>;
    saveRecording: (uri: string, recording: NewRecording) => Promise<void>;
  };
  newId: () => string;
  device: string;
  now?: () => Date;
  onEnd: () => void;
};

export type HandsFreeSession = {
  state: () => HandsFreeState;
  subscribe: (listener: () => void) => () => void;
  stop: () => Promise<void>;
};

const FENCE = /^ {0,3}(```|~~~)\s*([\w-]*)[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm;

export function speakable(markdown: string): string {
  return markdown
    .replace(FENCE, (_block, _fence, lang: string) => (lang.toLowerCase() === 'mermaid' ? 'Diagram skipped.' : 'Code skipped.'))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^ {0,3}([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function readAloud(prompt: Prompt): string {
  const [preferred] = prompt.suggestions;
  const read = `${prompt.title}.\n${speakable(prompt.text)}`;
  return preferred ? `${read}\nVolume up: ${preferred}.` : read;
}

export const NOTHING_LEFT = 'No prompts left.';

export const PROMPT_READY = 'Prompt ready.';

const byAge = (a: Prompt, b: Prompt) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);

export function startHandsFree(ports: HandsFreePorts): HandsFreeSession {
  const { data, speech, recorder } = ports;
  const now = ports.now ?? (() => new Date());
  const listeners = new Set<() => void>();
  const skipped = new Set<string>();
  let current: HandsFreeState = { phase: 'reading', prompt: null };
  let turn = 0;
  let recordingStartedAt = 0;

  const set = (phase: HandsFreePhase, prompt: Prompt | null) => {
    current = { phase, prompt };
    listeners.forEach((listener) => listener());
  };

  const queue = (): Prompt[] => {
    const { prompts, recordings } = data.snapshot();
    const spoken = new Set(recordings.flatMap((recording) => (recording.promptId && !recording.transcript ? [recording.promptId] : [])));
    return prompts.filter((prompt) => !prompt.answer && !skipped.has(prompt.id) && !spoken.has(prompt.id)).sort(byAge);
  };

  const say = async (text: string, after: () => void) => {
    const mine = turn;
    const outcome = await speech.say(text).catch(() => 'done' as const);
    if (mine === turn && outcome === 'done' && current.phase !== 'ended') after();
  };

  const interrupt = () => {
    turn += 1;
    speech.stop();
  };

  const present = (prefix = '') => {
    const [prompt] = queue();
    if (!prompt) {
      set('reading', null);
      void say(prefix + NOTHING_LEFT, () => set('waiting', null));
      return;
    }
    set('ready', prompt);
    void say(prefix + PROMPT_READY, () => {});
  };

  const read = (prompt: Prompt) => {
    set('reading', prompt);
    void data.markSeen(prompt.id).catch(() => {});
    void say(readAloud(prompt), () => set('waiting', prompt));
  };

  const accept = async (prompt: Prompt | null) => {
    if (!prompt) {
      await stop();
      return;
    }
    const [preferred] = prompt.suggestions;
    if (!preferred) {
      skipped.add(prompt.id);
      present('Skipped.\n');
      return;
    }
    set('saving', prompt);
    try {
      await data.answer(prompt.id, preferred);
      present(`Answered: ${preferred}.\n`);
    } catch {
      present('That prompt could not be answered.\n');
    }
  };

  const record = async (prompt: Prompt | null) => {
    set('cue', prompt);
    const mine = turn;
    console.log('HFDEBUG cue start', mine);
    const outcome = await speech.say(prompt ? 'Speak your answer.' : 'Speak your note.').catch(() => 'done' as const);
    console.log('HFDEBUG cue said', outcome, mine, turn, current.phase);
    if (mine !== turn || outcome !== 'done' || current.phase !== 'cue') return;
    try {
      await recorder.start();
      console.log('HFDEBUG recorder started');
    } catch (e) {
      console.log('HFDEBUG recorder failed', String(e));
      present('Recording failed.\n');
      return;
    }
    if (current.phase !== 'cue') {
      await recorder.finish().catch(() => null);
      return;
    }
    recordingStartedAt = now().getTime();
    recorder.ready();
    set('recording', prompt);
  };

  const save = async (): Promise<boolean> => {
    const { prompt } = current;
    set('saving', prompt);
    const take = await recorder.finish().catch((e) => { console.log('HFDEBUG finish failed', String(e)); return null; });
    console.log('HFDEBUG take', JSON.stringify(take));
    if (!take) return false;
    await data.saveRecording(take.uri, {
      id: ports.newId(),
      startedAt: new Date(recordingStartedAt).toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      durationMs: take.durationMs,
      source: 'app',
      device: ports.device,
      ...(prompt ? { promptId: prompt.id } : {}),
    });
    return true;
  };

  const finishRecording = async () => {
    const { prompt } = current;
    const saved = await save().catch(() => false);
    if (current.phase === 'ended') return;
    if (!saved) present('The recording could not be saved.\n');
    else present(prompt ? 'Answer saved.\n' : 'Note saved.\n');
  };

  const cancelCue = (prompt: Prompt | null) => {
    interrupt();
    if (!prompt) {
      present('Cancelled.\n');
      return;
    }
    set('reading', prompt);
    void say('Cancelled.', () => set('waiting', prompt));
  };

  const onKey = (key: HandsFreeKey) => {
    console.log('HFDEBUG key', key, current.phase);
    if (key === 'stop') {
      void stop();
      return;
    }
    const { phase, prompt } = current;
    if (phase === 'ended' || phase === 'saving') return;
    if (phase === 'cue') {
      cancelCue(prompt);
      return;
    }
    if (phase === 'recording') {
      void finishRecording();
      return;
    }
    interrupt();
    if (phase === 'ready' && prompt) {
      if (key === 'up') read(prompt);
      else void record(null);
      return;
    }
    if (key === 'down') void record(prompt);
    else void accept(prompt);
  };

  const onData = () => {
    const { phase, prompt } = current;
    if (phase !== 'waiting' && phase !== 'ready') return;
    const open = queue();
    if (prompt === null && open.length > 0) {
      interrupt();
      present('New prompt.\n');
    } else if (prompt !== null && !open.some((candidate) => candidate.id === prompt.id)) {
      interrupt();
      present();
    }
  };

  const stopKeys = ports.keys.onKey(onKey);
  const stopData = data.subscribe(onData);

  const stop = async () => {
    if (current.phase === 'ended') return;
    const recording = current.phase === 'recording';
    interrupt();
    stopKeys();
    stopData();
    if (recording) await save().catch(() => false);
    set('ended', null);
    ports.onEnd();
  };

  const [first] = queue();
  current = { phase: first ? 'ready' : 'reading', prompt: first ?? null };
  void (async () => {
    const mine = turn;
    await ports.chime().catch(() => {});
    if (mine === turn && current.phase !== 'ended') present();
  })();

  return {
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    stop,
  };
}
