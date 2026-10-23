import type { Recording, RecordingSource } from '@zero/agent-core';
import * as Device from 'expo-device';
import { randomUUID } from 'expo-crypto';
import {
  AudioQuality,
  requestNotificationPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
  type RecordingStatus,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

import { keepAudio } from '@/lib/recording-audio';

export type CaptureStatus = 'starting' | 'recording' | 'saving' | 'saved' | 'denied' | 'failed';

export type VoiceCapture = {
  status: CaptureStatus;
  elapsedMs: number;
  stop: () => Promise<void>;
};

const FORMAT: RecordingOptions = {
  directory: 'document',
  extension: '.m4a',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 32_000,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { audioQuality: AudioQuality.MEDIUM },
  web: {},
};

type Take = { id: string; startedAt: number; timeZone: string };

export function useVoiceCapture({ source, save }: {
  source: RecordingSource;
  save: (recording: Recording) => Promise<void>;
}): VoiceCapture {
  const [status, setStatus] = useState<CaptureStatus>('starting');
  const take = useRef<Take | null>(null);
  const finished = useRef(false);
  const latest = useRef({ source, save });
  useEffect(() => {
    latest.current = { source, save };
  }, [source, save]);

  const finish = useCallback(async (event: RecordingStatus) => {
    const current = take.current;
    if (!event.isFinished || !current || finished.current) return;
    finished.current = true;
    if (event.hasError || !event.url) {
      setStatus('failed');
      return;
    }
    setStatus('saving');
    try {
      const durationMs = Date.now() - current.startedAt;
      keepAudio(event.url, current.id);
      await latest.current.save({
        id: current.id,
        startedAt: new Date(current.startedAt).toISOString(),
        timeZone: current.timeZone,
        durationMs,
        source: latest.current.source,
        device: Device.modelName ?? 'Unknown phone',
      });
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  }, []);

  const recorder = useAudioRecorder(FORMAT, (event) => { void finish(event); });
  const { durationMillis } = useAudioRecorderState(recorder, 250);

  const begun = useRef(false);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    (async () => {
      if (!(await requestRecordingPermissionsAsync()).granted) {
        setStatus('denied');
        return;
      }
      const notifications = await requestNotificationPermissionsAsync();
      await setAudioModeAsync({ allowsRecording: true, allowsBackgroundRecording: notifications.granted, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      take.current = {
        id: randomUUID(),
        startedAt: Date.now(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      setStatus('recording');
    })().catch(() => setStatus('failed'));
  }, [recorder]);

  const stop = useCallback(async () => {
    if (!take.current || finished.current) return;
    await recorder.stop();
  }, [recorder]);

  return { status, elapsedMs: durationMillis, stop };
}
