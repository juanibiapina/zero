import { Host, Icon } from '@expo/ui';
import { toast, type Recording, type TaskdoReplica } from '@zero/agent-core';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { BackHandler, FlatList, InteractionManager, Linking, Pressable, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useColor } from '@/lib/theme';
import { useTodoReplica } from '@/lib/todo-replica-hook';
import { localAudio, useVoiceCapture, type CaptureStatus } from '@/lib/voice-capture';

const PLAY_ICON = Icon.select({ ios: 'play.fill', android: import('@expo/material-symbols/play_arrow.xml') });
const PAUSE_ICON = Icon.select({ ios: 'pause.fill', android: import('@expo/material-symbols/pause.xml') });

const backToHome = () => {
  router.dismissTo('/browse');
  router.navigate('/');
};
const backToBrowse = () => router.dismissTo('/browse');

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function formatStartedAt({ startedAt, timeZone }: Recording): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(new Date(startedAt));
  } catch {
    return new Intl.DateTimeFormat('en-GB', options).format(new Date(startedAt));
  }
}

const STATUS_TEXT: Record<CaptureStatus, string> = {
  starting: 'Starting…',
  recording: 'Recording',
  saving: 'Saving…',
  saved: 'Saved',
  denied: 'Zero needs microphone access to record.',
  failed: 'The recording couldn’t be saved.',
};

export function RecordScreen() {
  const replica = useTodoReplica();
  const { source } = useLocalSearchParams<{ source?: string }>();
  const save = useCallback(async (recording: Recording) => {
    if (!replica) throw new Error('Your workspace is not open');
    await replica.recordings.add(recording);
    backToHome();
    InteractionManager.runAfterInteractions(() => toast(`Saved · ${formatDuration(recording.durationMs)}`));
  }, [replica]);
  const { status, elapsedMs, stop } = useVoiceCapture({ source: source === 'widget' ? 'widget' : 'app', save });

  const back = useCallback(() => {
    if (status === 'recording') void stop();
    else if (status !== 'saving' && status !== 'saved') backToHome();
  }, [status, stop]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => sub.remove();
  }, [back]);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Voice note" back={{ label: 'Home', accessibilityLabel: 'Back to Home', onPress: back }} />
      <View className="flex-1 items-center justify-center gap-4 px-screen-x">
        <Text accessibilityRole="timer" className="text-[56px] font-light text-foreground" style={{ fontVariant: ['tabular-nums'] }}>
          {formatDuration(elapsedMs)}
        </Text>
        <Text variant="subtitle" className="text-center">{STATUS_TEXT[status]}</Text>
        {status === 'denied' ? (
          <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} className="min-h-12 justify-center">
            <Text className="font-semibold text-accent">Open settings</Text>
          </Pressable>
        ) : null}
      </View>
      <View className="items-center pb-16">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop and save"
          disabled={status !== 'recording'}
          onPress={() => void stop()}
          className={status === 'recording' ? 'h-24 w-24 items-center justify-center rounded-full bg-danger' : 'h-24 w-24 items-center justify-center rounded-full bg-surface-muted'}
        >
          <View className="h-8 w-8 rounded-md bg-on-accent" />
        </Pressable>
      </View>
    </View>
  );
}

function useRecordings(replica: TaskdoReplica | null): Recording[] | null {
  return useSyncExternalStore(
    useCallback((listener: () => void) => replica?.subscribe(() => listener()) ?? (() => {}), [replica]),
    useCallback(() => replica?.snapshot().recordings ?? null, [replica]),
  );
}

function RecordingRow({ recording, playing, onToggle }: { recording: Recording; playing: boolean; onToggle: (recording: Recording) => void }) {
  const color = useColor('--color-accent');
  const muted = useColor('--color-foreground-muted');
  const here = localAudio(recording.id) !== null;
  const when = formatStartedAt(recording);
  return (
    <ListRow
      leading={(
        <Host matchContents>
          <Icon name={playing ? PAUSE_ICON : PLAY_ICON} size={22} color={here ? color : muted} />
        </Host>
      )}
      trailing={<Text variant="subtitle" style={{ fontVariant: ['tabular-nums'] }}>{formatDuration(recording.durationMs)}</Text>}
      accessibilityLabel={here ? `${playing ? 'Pause' : 'Play'} recording from ${when}` : `Recording from ${when}, on ${recording.device}`}
      onPress={here ? () => onToggle(recording) : undefined}
      className="min-h-12"
    >
      <Text>{when}</Text>
      {here ? null : <Text variant="caption">{`On ${recording.device}`}</Text>}
    </ListRow>
  );
}

export function RecordingsScreen() {
  const replica = useTodoReplica();
  const recordings = useRecordings(replica);
  const player = useAudioPlayer(null);
  const playback = useAudioPlayerStatus(player);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true });
  }, []);

  const toggle = useCallback((recording: Recording) => {
    const uri = localAudio(recording.id);
    if (!uri) return;
    if (current === recording.id) {
      if (playback.playing) {
        player.pause();
        return;
      }
      if (playback.duration > 0 && playback.currentTime >= playback.duration) void player.seekTo(0);
      player.play();
      return;
    }
    player.replace({ uri });
    player.play();
    setCurrent(recording.id);
  }, [current, playback.playing, playback.currentTime, playback.duration, player]);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Recordings" back={{ label: 'Browse', accessibilityLabel: 'Back to Browse', onPress: backToBrowse }} />
      {recordings === null ? (
        <Text variant="subtitle" className="px-screen-x py-6">Opening your recordings…</Text>
      ) : recordings.length === 0 ? (
        <Text variant="subtitle" className="px-screen-x py-6">No recordings yet.</Text>
      ) : (
        <FlatList
          data={recordings}
          keyExtractor={(recording) => recording.id}
          renderItem={({ item }) => (
            <RecordingRow recording={item} playing={current === item.id && playback.playing} onToggle={toggle} />
          )}
        />
      )}
    </View>
  );
}
