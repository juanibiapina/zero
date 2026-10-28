import type { Recording, TodoSnapshot } from '@zero/agent-core';

export type TranscriptionUpload = 'done' | 'not-synced' | 'later';

type Replica = {
  snapshot: () => Pick<TodoSnapshot, 'recordings'>;
  subscribe: (listener: () => void) => () => void;
};

export type TranscriptionOutboxOptions = {
  replica: Replica;
  localAudio: (id: string) => string | null;
  upload: (id: string, uri: string) => Promise<TranscriptionUpload>;
  onResume: (listener: () => void) => () => void;
  retryDelaysMs?: number[];
};

export const NOT_SYNCED_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

export function startTranscriptionOutbox({
  replica,
  localAudio,
  upload,
  onResume,
  retryDelaysMs = NOT_SYNCED_RETRY_DELAYS_MS,
}: TranscriptionOutboxOptions): () => void {
  const sent = new Set<string>();
  const parked = new Set<string>();
  const attempts = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let running = false;
  let stopped = false;

  const next = (): { recording: Recording; uri: string } | null => {
    for (const recording of replica.snapshot().recordings) {
      if (recording.transcript || sent.has(recording.id) || parked.has(recording.id) || timers.has(recording.id)) continue;
      const uri = localAudio(recording.id);
      if (uri) return { recording, uri };
    }
    return null;
  };

  const retrySoon = (id: string) => {
    const attempt = attempts.get(id) ?? 0;
    const delay = retryDelaysMs[attempt];
    if (delay === undefined) {
      parked.add(id);
      return;
    }
    attempts.set(id, attempt + 1);
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      void drain();
    }, delay));
  };

  const drain = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (let item = next(); item && !stopped; item = next()) {
        const { id } = item.recording;
        const outcome = await upload(id, item.uri).catch((): TranscriptionUpload => 'later');
        if (outcome === 'done') sent.add(id);
        else if (outcome === 'not-synced') retrySoon(id);
        else parked.add(id);
      }
    } finally {
      running = false;
    }
  };

  const unsubscribe = replica.subscribe(() => { void drain(); });
  const stopResume = onResume(() => {
    parked.clear();
    attempts.clear();
    void drain();
  });
  void drain();

  return () => {
    stopped = true;
    unsubscribe();
    stopResume();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
