import { BottomSheet, Host, Icon } from '@expo/ui';
import { todoSyncPresentation, type TodoSyncDisplayKind } from '@zero/agent-core';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useTodoDataContext } from '@/lib/todo-data-context';
import { useColor } from '@/lib/theme';

const ICONS = {
  synced: Icon.select({ ios: 'checkmark.icloud', android: import('@expo/material-symbols/cloud_done.xml') }),
  offline: Icon.select({ ios: 'icloud.slash', android: import('@expo/material-symbols/cloud_off.xml') }),
  warning: Icon.select({ ios: 'exclamationmark.triangle', android: import('@expo/material-symbols/warning.xml') }),
  local: Icon.select({ ios: 'internaldrive', android: import('@expo/material-symbols/download_for_offline.xml') }),
  update: Icon.select({ ios: 'arrow.down.circle', android: import('@expo/material-symbols/download_done.xml') }),
} as const;

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
  if (state.isUpdatePending) return 'Update ready for next launch';
  if (state.checkError || state.downloadError) return 'Could not check for updates';
  return 'Automatic updates on';
}

function StatusIcon({ kind, updateReady }: { kind: TodoSyncDisplayKind; updateReady: boolean }) {
  const color = useColor(kind === 'warning' ? '--color-danger' : '--color-foreground-secondary');
  if (kind === 'busy') return <ActivityIndicator color={color} />;
  const icon = updateReady && kind !== 'offline' && kind !== 'warning' ? ICONS.update : ICONS[kind];
  return (
    <Host matchContents>
      <Icon name={icon} size={22} color={color} testID={`sync-status-${kind}`} />
    </Host>
  );
}

export function SyncStatusControl() {
  const data = useTodoDataContext();
  const updates = Updates.useUpdates();
  const [open, setOpen] = useState(false);
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
  const triggerLabel = (updating || updates.isUpdatePending)
    && sync.kind !== 'warning'
    && sync.kind !== 'offline'
    ? updateLabel(updates)
    : sync.label;
  const lastSync = data.sync.lastSyncedAt ? new Date(data.sync.lastSyncedAt) : null;
  const runningUpdate = updates.currentlyRunning.createdAt;
  const updateError = updates.checkError ?? updates.downloadError;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={triggerLabel}
        hitSlop={8}
        onPress={() => setOpen(true)}
        className="h-10 w-10 items-center justify-center rounded-full"
      >
        <StatusIcon kind={triggerKind} updateReady={updates.isUpdatePending} />
      </Pressable>
      <Host>
        <BottomSheet
          isPresented={open}
          onDismiss={() => setOpen(false)}
          showDragIndicator
          contentPadding={{ top: 8, bottom: 28, left: 20, right: 20 }}
          testID="sync-status-sheet"
        >
          <View className="gap-5">
            <View className="gap-1">
              <Text variant="title" selectable>Sync status</Text>
              <Text variant="subtitle" selectable>{sync.description}</Text>
            </View>
            <View className="gap-1 rounded-2xl bg-surface-muted px-4 py-2">
              <DetailRow label="Status"><Text className="font-semibold" selectable>{sync.label}</Text></DetailRow>
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
            <View className="gap-1">
              <Text variant="section">App</Text>
              <View className="gap-1 rounded-2xl bg-surface-muted px-4 py-2">
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
              {updateError ? <Text variant="error" selectable>{updateError.message}</Text> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close sync status"
              onPress={() => setOpen(false)}
              className="h-12 items-center justify-center rounded-xl bg-surface-muted"
            >
              <Text className="font-semibold">Done</Text>
            </Pressable>
          </View>
        </BottomSheet>
      </Host>
    </>
  );
}
