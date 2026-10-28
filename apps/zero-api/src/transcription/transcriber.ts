import type { Transcript } from "@zero/agent-core";

export type TranscriptionHints = {
  keywords: string[];
};

export type SpeechToText = {
  model: string;
  transcribe(audio: Blob, hints: TranscriptionHints): Promise<string>;
};

export type Cleanup = {
  model: string;
  clean(verbatim: string, hints: TranscriptionHints): Promise<string>;
};

export type Transcriber = (audio: Blob, hints: TranscriptionHints) => Promise<Transcript>;

const countWords = (text: string): number => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;

const plausible = (verbatim: string, cleaned: string): boolean => {
  const before = countWords(verbatim);
  const after = countWords(cleaned);
  if (after === 0) return false;
  if (after > before * 1.1 + 3) return false;
  return before < 20 || after >= before * 0.3;
};

export function createTranscriber({ speechToText, cleanup, now = () => new Date() }: {
  speechToText: SpeechToText;
  cleanup: Cleanup;
  now?: () => Date;
}): Transcriber {
  return async (audio, hints) => {
    const verbatim = (await speechToText.transcribe(audio, hints)).trim();
    const transcribedAt = () => now().toISOString();
    if (countWords(verbatim) === 0) {
      return { text: "", verbatim, model: speechToText.model, transcribedAt: transcribedAt() };
    }
    const cleaned = (await cleanup.clean(verbatim, hints)).trim();
    if (!plausible(verbatim, cleaned)) {
      return { text: verbatim, verbatim, model: speechToText.model, transcribedAt: transcribedAt() };
    }
    return { text: cleaned, verbatim, model: `${speechToText.model}+${cleanup.model}`, transcribedAt: transcribedAt() };
  };
}
