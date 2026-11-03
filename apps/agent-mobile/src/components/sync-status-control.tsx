import { Host, Icon } from '@expo/ui';
import { todoSyncPresentation, type TodoSyncDisplayKind } from '@zero/agent-core';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type ViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { restartIntoUpdate } from '@/lib/app-updates';
import { useTodoDataContext } from '@/lib/todo-data-context';
import { useColor } from '@/lib/theme';

const ICONS = {
  synced: Icon.select({ ios: 'checkmark.icloud', android: import('@expo/material-symbols/cloud_done.xml') }),
  offline: Icon.select({ ios: 'icloud.slash', android: import('@expo/material-symbols/cloud_off.xml') }),
  warning: Icon.select({ ios: 'exclamationmark.triangle', android: import('@expo/material-symbols/warning.xml') }),
  local: Icon.select({ ios: 'internaldrive', android: import('@expo/material-symbols/download_for_offline.xml') }),
  update: Icon.select({ ios: 'arrow.down.circle', android: import('@expo/material-symbols/download_done.xml') }),
  ready: Icon.select({ ios: 'checkmark.circle.fill', android: import('@expo/material-symbols/check_circle.xml') }),
} as const;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatRelative(value: string | Date, now = new Date()): string {
  const date = new Date(value);
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1_000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="flex-row items-start justify-between gap-6 py-2">
      <Text variant="subtitle">{label}</Text>
      <View className="min-w-0 flex-1 items-end">{children}</View>
    </View>
  );
}

function updateLabel(state: ReturnType<typeof Updates.useUpdates>): string {
  if (state.isRestarting) return 'Applying update';
  if (state.isDownloading) {
    return state.downloadProgress == null
      ? 'Downloading update'
      : `Downloading update · ${Math.round(state.downloadProgress * 100)}%`;
  }
  if (state.isChecking || state.isStartupProcedureRunning) return 'Checking for updates';
  if (state.isUpdatePending) return 'Update ready';
  if (state.checkError || state.downloadError) return 'Could not check for updates';
  return 'Automatic updates on';
}

function StatusIcon({ kind, updateReady }: { kind: TodoSyncDisplayKind; updateReady: boolean }) {
  const color = useColor(kind === 'warning' ? '--color-danger' : '--color-foreground-secondary');
  const accent = useColor('--color-accent');
  const iconKind = kind === 'busy' ? 'synced' : kind;
  const showUpdate = updateReady && iconKind !== 'offline' && iconKind !== 'warning';
  const icon = showUpdate ? ICONS.update : ICONS[iconKind];
  return (
    <View
      testID="sync-status-icon-frame"
      className="items-center justify-center"
      style={{ width: 24, height: 24 }}
    >
      <View
        pointerEvents="none"
        className="absolute inset-0 items-center justify-center"
        style={{ opacity: kind === 'busy' ? 0 : 1 }}
      >
        <Host matchContents>
          <Icon
            name={icon}
            size={22}
            color={color}
            testID={kind === 'busy' ? undefined : `sync-status-${kind}`}
          />
        </Host>
      </View>
      {kind === 'busy' ? (
        <ActivityIndicator testID="sync-status-busy" color={color} />
      ) : null}
      {showUpdate && kind !== 'busy' ? (
        <View
          testID="update-ready-tick"
          pointerEvents="none"
          className="absolute items-center justify-center rounded-full bg-background"
          style={{ right: -3, bottom: -3, width: 13, height: 13 }}
        >
          <Host matchContents>
            <Icon name={ICONS.ready} size={11} color={accent} />
          </Host>
        </View>
      ) : null}
    </View>
  );
}

export function SyncStatusControl() {
  const data = useTodoDataContext();
  const updates = Updates.useUpdates();
  const [open, setOpen] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState({ top: 72, right: 16 });
  const triggerRef = useRef<ViewInstance>(null);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const rippleColor = useColor('--color-ripple');
  if (!data) return null;

  const sync = todoSyncPresentation({
    signedIn: data.signedIn,
    durable: data.durable,
    sync: data.sync,
  });
  const updating = updates.isChecking
    || updates.isDownloading
    || updates.isRestarting
    || updates.isStartupProcedureRunning;
  const triggerKind = sync.kind === 'warning' || sync.kind === 'offline'
    ? sync.kind
    : updating ? 'busy' : sync.kind;
  const showTrigger = sync.kind === 'warning' || (updates.isUpdatePending && !updates.isRestarting);
  const attentionKind = sync.kind === 'warning' ? 'warning' : 'synced';
  const attentionLabel = sync.kind === 'warning' ? sync.label : 'Update ready';
  const canRestart = updates.isUpdatePending && !updates.isRestarting;
  const lastSync = data.sync.lastSyncedAt ? new Date(data.sync.lastSyncedAt) : null;
  const runningUpdate = updates.currentlyRunning.createdAt;
  const updateError = updates.checkError ?? updates.downloadError;

  const showPopover = () => {
    setAnchor({ top: insets.top + 64, right: 16 });
    setOpen(true);
    triggerRef.current?.measureInWindow((x, y, triggerWidth, triggerHeight) => {
      setAnchor({
        top: y + triggerHeight + 8,
        right: Math.max(16, width - x - triggerWidth),
      });
    });
  };

  // One tap moves to the downloaded update. If the restart fails, the details
  // explain why instead of leaving the tap without effect.
  const restart = async () => {
    setRestartError(null);
    try {
      await restartIntoUpdate();
    } catch (error) {
      setRestartError(messageOf(error));
      showPopover();
    }
  };

  const popoverWidth = Math.min(340, width - 32);
  const popoverMaxHeight = Math.max(240, height - anchor.top - insets.bottom - 16);

  return (
    <>
      {showTrigger ? <Pressable
        ref={triggerRef}
        accessibilityRole="button"
        accessibilityLabel={attentionLabel}
        accessibilityHint={sync.kind === 'warning'
          ? 'Shows sync and app update details'
          : 'Restarts Zero into the new version'}
        android_ripple={{ color: rippleColor, borderless: true, radius: 24 }}
        onPress={sync.kind === 'warning' ? showPopover : () => void restart()}
        className="h-12 w-12 items-center justify-center overflow-hidden rounded-full"
      >
        <View pointerEvents="none">
          <StatusIcon kind={attentionKind} updateReady={updates.isUpdatePending} />
        </View>
      </Pressable> : null}
      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss sync status"
            onPress={() => setOpen(false)}
            className="absolute inset-0"
          />
          <View
            accessibilityLabel="Sync status details"
            style={{
              top: anchor.top,
              right: anchor.right,
              width: popoverWidth,
              maxHeight: popoverMaxHeight,
            }}
            className="absolute overflow-hidden rounded-2xl border border-divider bg-surface shadow-raised"
          >
            <ScrollView
              contentContainerStyle={{ padding: 20, gap: 16 }}
              showsVerticalScrollIndicator={false}
            >
              <View className="flex-row items-start gap-3">
                <View className="h-10 w-10 items-center justify-center rounded-full bg-surface-muted" pointerEvents="none">
                  <StatusIcon kind={triggerKind} updateReady={updates.isUpdatePending} />
                </View>
                <View className="min-w-0 flex-1 gap-0.5 pt-0.5">
                  <Text className="text-editor" selectable>{sync.label}</Text>
                  <Text variant="subtitle" selectable>{sync.description}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close sync status"
                  onPress={() => setOpen(false)}
                  className="h-12 items-center justify-center px-1"
                >
                  <Text variant="subtitle" className="font-semibold text-accent">Close</Text>
                </Pressable>
              </View>

              <View className="h-px bg-divider" />

              <View className="gap-1">
                <DetailRow label="Last synced">
                  {lastSync ? (
                    <>
                      <Text className="font-semibold" selectable>{formatRelative(data.sync.lastSyncedAt!)}</Text>
                      <Text variant="caption" selectable>{lastSync.toLocaleString()}</Text>
                    </>
                  ) : <Text className="font-semibold" selectable>Not yet</Text>}
                </DetailRow>
                <DetailRow label="Offline copy">
                  <Text className="font-semibold" selectable>{data.durable ? 'Available' : 'Unavailable'}</Text>
                </DetailRow>
              </View>

              {data.durabilityError ? <Text variant="error" selectable>{data.durabilityError}</Text> : null}

              <View className="h-px bg-divider" />

              <View className="gap-1">
                <Text variant="section">App</Text>
                <DetailRow label="Version">
                  <Text className="font-semibold" selectable>{Constants.expoConfig?.version ?? 'Development'}</Text>
                </DetailRow>
                <DetailRow label="Updates"><Text className="font-semibold" selectable>{updateLabel(updates)}</Text></DetailRow>
                {runningUpdate ? (
                  <DetailRow label="Content updated">
                    <Text className="font-semibold" selectable>{formatRelative(runningUpdate)}</Text>
                    <Text variant="caption" selectable>{runningUpdate.toLocaleString()}</Text>
                  </DetailRow>
                ) : null}
                {updates.lastCheckForUpdateTimeSinceRestart ? (
                  <DetailRow label="Last checked">
                    <Text className="font-semibold" selectable>{formatRelative(updates.lastCheckForUpdateTimeSinceRestart.toISOString())}</Text>
                  </DetailRow>
                ) : null}
              </View>

              {canRestart ? (
                <View className="items-end">
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void restart()}
                    className="h-12 justify-center px-1"
                  >
                    <Text className="font-semibold text-accent">Restart to update</Text>
                  </Pressable>
                </View>
              ) : null}

              {restartError ? <Text variant="error" selectable>{restartError}</Text> : null}
              {updateError ? <Text variant="error" selectable>{updateError.message}</Text> : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}
