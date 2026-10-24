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
import { Vibration } from 'react-native';

import { keepAudio } from '@/lib/recording-audio';
import { routeToHeadset, watchRecordingInput, type HeadsetRoute, type Microphone } from '../../modules/headset-mic';

export type { Microphone } from '../../modules/headset-mic';

export type CaptureStatus = 'starting' | 'recording' | 'saving' | 'saved' | 'denied' | 'failed';

export type VoiceCapture = {
  status: CaptureStatus;
  mic: Microphone | null;
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

const READY_VIBRATION_MS = 60;

export function useVoiceCapture({ source, save }: {
  source: RecordingSource;
  save: (recording: Recording) => Promise<void>;
}): VoiceCapture {
  const [status, setStatus] = useState<CaptureStatus>('starting');
  const [mic, setMic] = useState<Microphone | null>(null);
  const take = useRef<Take | null>(null);
  const route = useRef<HeadsetRoute | null>(null);
  const unwatch = useRef<(() => void) | null>(null);
  const unmounted = useRef(false);

  const letGo = useCallback(() => {
    unwatch.current?.();
    unwatch.current = null;
    route.current?.release();
    route.current = null;
  }, []);
  const finished = useRef(false);
  const latest = useRef({ source, save });
  useEffect(() => {
    latest.current = { source, save };
  }, [source, save]);

  const finish = useCallback(async (event: RecordingStatus) => {
    const current = take.current;
    if (!event.isFinished || !current || finished.current) return;
    finished.current = true;
    letGo();
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
  }, [letGo]);

  const recorder = useAudioRecorder(FORMAT, (event) => { void finish(event); });
  const { durationMillis } = useAudioRecorderState(recorder, 250);

  const begun = useRef(false);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    let listening = false;
    const listen = (input: Microphone | null) => {
      setMic(input);
      if (listening || !take.current) return;
      listening = true;
      Vibration.vibrate(READY_VIBRATION_MS);
      setStatus('recording');
    };
    (async () => {
      if (!(await requestRecordingPermissionsAsync()).granted) {
        setStatus('denied');
        return;
      }
      const notifications = await requestNotificationPermissionsAsync();
      await setAudioModeAsync({ allowsRecording: true, allowsBackgroundRecording: notifications.granted, playsInSilentMode: true });
      route.current = await routeToHeadset().catch(() => null);
      if (unmounted.current) {
        letGo();
        return;
      }
      let firstReport: { mic: Microphone | null } | null = null;
      unwatch.current = watchRecordingInput((input) => {
        if (take.current) listen(input);
        else firstReport = { mic: input };
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
      take.current = {
        id: randomUUID(),
        startedAt: Date.now(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      const reported = firstReport as { mic: Microphone | null } | null;
      if (!unwatch.current) listen(null);
      else if (reported) listen(reported.mic);
    })().catch(() => {
      letGo();
      setStatus('failed');
    });
  }, [recorder, letGo]);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (!take.current) letGo();
    };
  }, [letGo]);

  const stop = useCallback(async () => {
    if (!take.current || finished.current) return;
    await recorder.stop();
  }, [recorder]);

  return { status, mic, elapsedMs: durationMillis, stop };
}
