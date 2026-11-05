import type { TaskdoReplica } from '@zero/agent-core';
import { randomUUID } from 'expo-crypto';
import * as Device from 'expo-device';
import { createAudioPlayer, requestNotificationPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import { router } from 'expo-router';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { BackHandler, Linking, Pressable, Vibration, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { startHandsFree, type HandsFreePorts, type HandsFreeSession, type HandsFreeState } from '@/lib/hands-free';
import { keepAudio } from '@/lib/recording-audio';
import { useTodoReplica } from '@/lib/todo-replica-hook';
import { routeToHeadset, type HeadsetRoute } from '../../modules/headset-mic';
import { takeHandsFreeControls, type HandsFreeControls } from '../../modules/hands-free';

type Problem = 'denied' | 'unavailable';

const READY_VIBRATION_MS = 60;

const backToBrowse = () => router.dismissTo('/browse');

const START_SOUND = require('../../assets/sounds/hands-free-start.wav');

const chime: HandsFreePorts['chime'] = () => new Promise((resolve) => {
  const player = createAudioPlayer(START_SOUND);
  const done = () => {
    subscription.remove();
    player.remove();
    resolve();
  };
  const subscription = player.addListener('playbackStatusUpdate', (status) => {
    if (status.didJustFinish) done();
  });
  try {
    player.play();
  } catch {
    done();
  }
});

const speech: HandsFreePorts['speech'] = {
  say: (text) => new Promise((resolve) => {
    Speech.speak(text.slice(0, Speech.maxSpeechInputLength), {
      onDone: () => resolve('done'),
      onStopped: () => resolve('stopped'),
      onError: () => resolve('done'),
    });
  }),
  stop: () => { void Speech.stop(); },
};

function ports(replica: TaskdoReplica, controls: HandsFreeControls, onEnd: () => void): HandsFreePorts {
  let route: HeadsetRoute | null = null;
  return {
    keys: controls,
    speech,
    chime,
    recorder: {
      start: async () => {
        route = await routeToHeadset().catch(() => null);
        controls.startRecording();
      },
      finish: async () => {
        try {
          return controls.finishRecording();
        } finally {
          route?.release();
          route = null;
        }
      },
      ready: () => Vibration.vibrate(READY_VIBRATION_MS),
    },
    data: {
      snapshot: () => replica.snapshot(),
      subscribe: (listener) => replica.subscribe(() => listener()),
      markSeen: (id) => replica.prompts.markSeen(id),
      answer: (id, text) => replica.prompts.answer(id, text),
      saveRecording: async (uri, recording) => {
        keepAudio(uri, recording.id);
        await replica.recordings.add(recording);
      },
    },
    newId: randomUUID,
    device: Device.modelName ?? 'Unknown phone',
    onEnd: () => {
      controls.release();
      route?.release();
      onEnd();
    },
  };
}

function useHandsFree(): { state: HandsFreeState | null; problem: Problem | null; end: () => void } {
  const replica = useTodoReplica();
  const [session, setSession] = useState<HandsFreeSession | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    if (!replica) return;
    let leaving = false;
    let started: HandsFreeSession | null = null;
    void (async () => {
      if (!(await requestRecordingPermissionsAsync()).granted) {
        setProblem('denied');
        return;
      }
      await requestNotificationPermissionsAsync().catch(() => null);
      if (leaving) return;
      const controls = takeHandsFreeControls();
      if (!controls) {
        setProblem('unavailable');
        return;
      }
      started = startHandsFree(ports(replica, controls, () => { if (!leaving) backToBrowse(); }));
      setSession(started);
    })();
    return () => {
      leaving = true;
      void started?.stop();
    };
  }, [replica]);

  const state = useSyncExternalStore(
    useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => {}), [session]),
    useCallback(() => session?.state() ?? null, [session]),
  );
  const end = useCallback(() => {
    if (session) void session.stop();
    else backToBrowse();
  }, [session]);
  return { state, problem, end };
}

const PHASE_TEXT: Record<HandsFreeState['phase'], string> = {
  ready: 'Prompt waiting',
  reading: 'Reading aloud',
  waiting: 'Waiting for a key',
  cue: 'Get ready to speak',
  recording: 'Recording',
  saving: 'Saving…',
  ended: 'Hands-free is off',
};

function keys({ phase, prompt }: HandsFreeState): [string, string][] {
  if (phase === 'cue') return [['Any key', 'Cancel']];
  if (phase === 'recording') return [['Any key', 'Stop and save']];
  if (!prompt) return [['Volume up', 'End hands-free'], ['Volume down', 'Record a note']];
  if (phase === 'ready') return [['Volume up', 'Read it aloud'], ['Volume down', 'Record a note']];
  return [
    ['Volume up', prompt.suggestions[0] ?? 'Skip'],
    ['Volume down', 'Speak your answer'],
  ];
}

export function HandsFreeScreen() {
  const { state, problem, end } = useHandsFree();

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      end();
      return true;
    });
    return () => sub.remove();
  }, [end]);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Hands-free" back={{ label: 'Browse', accessibilityLabel: 'Back to Browse', onPress: end }} />
      <View className="flex-1 justify-center gap-6 px-screen-x">
        {problem === 'denied' ? (
          <>
            <Text variant="subtitle" className="text-center">Zero needs microphone access for hands-free.</Text>
            <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} className="min-h-12 items-center justify-center">
              <Text className="font-semibold text-accent">Open settings</Text>
            </Pressable>
          </>
        ) : problem === 'unavailable' ? (
          <Text variant="subtitle" className="text-center">Hands-free needs a newer version of Zero on this phone.</Text>
        ) : state ? (
          <>
            <View className="gap-2">
              <Text variant="caption" className="text-center">{PHASE_TEXT[state.phase]}</Text>
              <Text className="text-center text-2xl font-semibold">{state.prompt?.title ?? (state.phase === 'cue' || state.phase === 'recording' || state.phase === 'saving' ? 'Voice note' : 'No prompts left')}</Text>
            </View>
            <View className="gap-3">
              {keys(state).map(([key, action]) => (
                <View key={key} className="flex-row gap-3">
                  <Text className="w-28 font-semibold">{key}</Text>
                  <Text className="flex-1">{action}</Text>
                </View>
              ))}
            </View>
          </>
        ) : (
          <Text variant="subtitle" className="text-center">Starting…</Text>
        )}
      </View>
      <View className="items-center pb-16">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End hands-free"
          onPress={end}
          className="min-h-12 items-center justify-center rounded-full bg-surface-muted px-8"
        >
          <Text className="font-semibold">End hands-free</Text>
        </Pressable>
      </View>
    </View>
  );
}
