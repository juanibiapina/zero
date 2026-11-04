import type { Recording } from '@zero/agent-core';

// When a Recording started, in the time zone where it was recorded.
export function formatStartedAt({ startedAt, timeZone }: Pick<Recording, 'startedAt' | 'timeZone'>): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(new Date(startedAt));
  } catch {
    return new Intl.DateTimeFormat('en-GB', options).format(new Date(startedAt));
  }
}

// A Recording's name: its transcript title, or when it started while it has none.
export function recordingLabel(recording: Recording): string {
  return recording.transcript?.title || formatStartedAt(recording);
}
