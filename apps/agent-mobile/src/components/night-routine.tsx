import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { messageOf, toast, type NightStep, type NightView, type TaskdoReplica } from '@zero/agent-core';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import ReorderableList, { useReorderableDrag, type ReorderableListReorderEvent } from 'react-native-reorderable-list';
import { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Chip } from '@/components/medicine-editor';
import { useQuickAdd } from '@/components/quick-add-composer';
import { ScreenHeader } from '@/components/screen-header';
import { Input } from '@/components/ui/input';
import { CheckCircle } from '@/components/ui/list-row';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useNightRoutine } from '@/lib/night-routine';
import { useColor } from '@/lib/theme';

const NIGHT_ROUTINE_HREF = '/browse/night-routine';
const BACK_TO_BROWSE = { label: 'Browse', accessibilityLabel: 'Back to Browse', onPress: () => router.dismissTo('/browse') };

const clockOf = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const timeOf = (iso: string) => clockOf(new Date(iso));
const nightLabel = (night: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${night}T12:00:00`));

export function NightRoutineButton() {
  const { view } = useNightRoutine();
  if (!view?.showIcon) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Night routine"
      onPress={() => router.navigate(NIGHT_ROUTINE_HREF, { withAnchor: true })}
      className="h-12 w-12 items-center justify-center rounded-full"
    >
      <Text className="text-[22px]">🌙</Text>
    </Pressable>
  );
}

export function NightRoutineScreen() {
  const { replica, view } = useNightRoutine();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Night routine" back={BACK_TO_BROWSE} />
      {replica && view ? (
        <NightRoutineContent replica={replica} view={view} />
      ) : (
        <Text variant="subtitle" className="px-screen-x py-6">Opening your night routine…</Text>
      )}
    </View>
  );
}

function NightRoutineContent({ replica, view }: { replica: TaskdoReplica; view: NightView }) {
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NightStep | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [pickingTime, setPickingTime] = useState(false);
  const closed = view.state === 'closed';
  const routine = replica.nightRoutine;
  const fail = useCallback((cause: unknown) => setError(messageOf(cause)), []);

  const add = useQuickAdd({ replica, surface: { kind: 'night-routine' }, onError: setError });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', add.handleBack);
    return () => sub.remove();
  }, [add.handleBack]);

  const complete = useCallback((step: NightStep) => {
    setError(null);
    routine.complete(step.id).then(
      () => toast(`${step.text} done`, { id: 'undo', action: { label: 'Undo', onPress: () => { routine.uncomplete(step.id).catch(fail); } } }),
      fail,
    );
  }, [routine, fail]);

  const goToBed = useCallback(() => {
    setError(null);
    routine.goToBed().then(
      (night) => toast('Good night', { id: 'undo', action: { label: 'Undo', onPress: () => { routine.undoBed(night).catch(fail); } } }),
      fail,
    );
  }, [routine, fail]);

  const onReorder = useCallback(({ from, to }: ReorderableListReorderEvent) => {
    const step = view.open[from];
    if (from === to || !step) return;
    setError(null);
    routine.moveStep(step.id, to).catch(fail);
  }, [routine, view.open, fail]);

  const panGesture = useMemo(() => Gesture.Pan().activateAfterLongPress(520), []);
  const renderItem = useCallback(
    ({ item }: { item: NightStep }) => <OpenStepRow step={item} onComplete={complete} onOpen={setEditing} />,
    [complete],
  );

  const header = (
    <View className="gap-1 px-screen-x pb-2">
      <View className="flex-row items-center gap-2">
        <Chip
          label={`Opens at ${view.opensAt}`}
          accessibilityLabel={`Change opening time, ${view.opensAt}`}
          disabled={closed}
          onPress={() => setPickingTime(true)}
        />
      </View>
      {error ? <Text variant="error" selectable>{error}</Text> : null}
      {closed ? <ClosedSummary view={view} /> : null}
      {!closed && view.steps.length === 0 ? (
        <Text variant="subtitle" className="py-4">Add the steps of your night routine</Text>
      ) : null}
      {!closed && view.steps.length > 0 && view.open.length === 0 ? (
        <Text variant="section" className="py-4">All done for tonight</Text>
      ) : null}
    </View>
  );

  const footer = (
    <View className="gap-2 pt-2" style={{ paddingBottom: insets.bottom + 96 }}>
      {!closed && view.done.length > 0 ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Done tonight, ${view.done.length}`}
            accessibilityState={{ expanded: showDone }}
            onPress={() => setShowDone((value) => !value)}
            className="min-h-12 justify-center px-screen-x"
          >
            <Text className="font-semibold text-foreground-secondary">{`${showDone ? '▾' : '▸'} Done tonight (${view.done.length})`}</Text>
          </Pressable>
          {showDone ? view.done.map((step) => (
            <Pressable
              key={step.id}
              accessibilityRole="button"
              accessibilityLabel={`Reopen "${step.text}"`}
              onPress={() => { setError(null); routine.uncomplete(step.id).catch(fail); }}
              onLongPress={() => setEditing(step)}
              className="min-h-12 flex-row items-center gap-3 px-screen-x py-row-y"
            >
              <View className="h-[22px] w-[22px] items-center justify-center rounded-full bg-accent">
                <Text className="text-[13px] text-on-accent">✓</Text>
              </View>
              <Text className="flex-1 text-foreground-secondary line-through">{step.text}</Text>
              <Text variant="caption" style={{ fontVariant: ['tabular-nums'] }}>{timeOf(step.doneAt)}</Text>
            </Pressable>
          )) : null}
        </View>
      ) : null}
      {!closed ? (
        <View className="px-screen-x pt-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Going to bed"
            onPress={goToBed}
            className="min-h-12 items-center justify-center rounded-full bg-accent"
          >
            <Text className="font-semibold text-on-accent">Going to bed</Text>
          </Pressable>
        </View>
      ) : null}
      <History view={view} />
    </View>
  );

  return (
    <>
      <ReorderableList
        style={{ flex: 1 }}
        data={closed ? [] : view.open}
        keyExtractor={(step) => step.id}
        panGesture={panGesture}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        itemLayoutAnimation={LinearTransition.duration(200)}
        onReorder={onReorder}
        keyboardShouldPersistTaps="handled"
      />
      {pickingTime ? (
        <DateTimePicker
          value={new Date(`2000-01-01T${view.opensAt}:00`)}
          mode="time"
          is24Hour
          onChange={(event, date) => {
            setPickingTime(false);
            if (event.type === 'set' && date) {
              setError(null);
              routine.setOpensAt(clockOf(date)).catch(fail);
            }
          }}
        />
      ) : null}
      <StepSheet
        step={editing}
        onClose={() => setEditing(null)}
        onRename={(step, text) => { setEditing(null); setError(null); routine.renameStep(step.id, text).catch(fail); }}
        onRemove={(step) => { setEditing(null); setError(null); routine.removeStep(step.id).catch(fail); }}
      />
      {closed ? null : add.element}
    </>
  );
}

function OpenStepRow({ step, onComplete, onOpen }: { step: NightStep; onComplete: (step: NightStep) => void; onOpen: (step: NightStep) => void }) {
  const drag = useReorderableDrag();
  const ripple = useColor('--color-ripple');
  return (
    <View className="bg-background">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Edit "${step.text}"`}
        android_ripple={{ color: ripple }}
        onPress={() => onOpen(step)}
        onLongPress={() => drag()}
        delayLongPress={500}
        className="flex-row items-center gap-3 px-screen-x py-row-y"
      >
        <CheckCircle label={`Complete "${step.text}"`} onPress={() => onComplete(step)} />
        <Text className="flex-1">{step.text}</Text>
      </Pressable>
      <View className="ml-[50px] h-px bg-divider" />
    </View>
  );
}

function ClosedSummary({ view }: { view: NightView }) {
  const undone = view.open;
  return (
    <View className="gap-2 py-4">
      <Text variant="section">
        {`Good night · ${view.done.length} of ${view.steps.length} done${view.wentToBedAt ? ` · bed at ${timeOf(view.wentToBedAt)}` : ''}`}
      </Text>
      {undone.length > 0 ? (
        <View className="gap-1">
          <Text variant="caption">Not done</Text>
          {undone.map((step) => <Text key={step.id} variant="subtitle">{step.text}</Text>)}
        </View>
      ) : null}
    </View>
  );
}

function History({ view }: { view: NightView }) {
  const withCounts = view.steps.filter((step) => view.counts[step.id]);
  if (withCounts.length === 0 && view.history.length === 0) return null;
  return (
    <View className="gap-2 px-screen-x pt-6">
      <Text accessibilityRole="header" variant="section">History</Text>
      {withCounts.map((step) => {
        const count = view.counts[step.id]!;
        return (
          <Text key={step.id} variant="subtitle" style={{ fontVariant: ['tabular-nums'] }}>
            {`${step.text} · ${count.done} of the last ${count.nights} ${count.nights === 1 ? 'night' : 'nights'}`}
          </Text>
        );
      })}
      {view.history.slice(0, 14).map((night) => {
        const done = night.steps.filter((step) => step.doneAt != null);
        return (
          <View key={night.night} className="gap-0.5 border-b border-divider py-2">
            <Text className="font-medium">
              {`${nightLabel(night.night)} · ${done.length} of ${night.steps.length}${night.wentToBedAt ? ` · bed at ${timeOf(night.wentToBedAt)}` : ''}`}
            </Text>
            {done.length > 0 ? <Text variant="caption">{done.map((step) => step.text).join(', ')}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

function StepSheet({ step, onClose, onRename, onRemove }: {
  step: NightStep | null;
  onClose: () => void;
  onRename: (step: NightStep, text: string) => void;
  onRemove: (step: NightStep) => void;
}) {
  return (
    <Sheet open={step != null} onClose={onClose} contextBridge={null}>
      {step ? <StepForm key={step.id} step={step} onClose={onClose} onRename={onRename} onRemove={onRemove} /> : null}
    </Sheet>
  );
}

function StepForm({ step, onClose, onRename, onRemove }: {
  step: NightStep;
  onClose: () => void;
  onRename: (step: NightStep, text: string) => void;
  onRemove: (step: NightStep) => void;
}) {
  const [text, setText] = useState(step.text);
  const valid = text.trim().length > 0;
  const save = () => { if (valid) onRename(step, text); };
  return (
    <View className="pb-2">
      <View className="mx-screen-x my-2 min-h-12 flex-row items-center rounded-xl bg-background px-3">
        <Input value={text} onChangeText={setText} accessibilityLabel="Step" returnKeyType="done" onSubmitEditing={save} className="min-h-12 flex-1" />
      </View>
      <View className="flex-row items-center justify-between px-screen-x py-3">
        <Pressable accessibilityRole="button" accessibilityLabel="Remove step" hitSlop={8} onPress={() => onRemove(step)}>
          <Text className="font-semibold text-danger">Remove</Text>
        </Pressable>
        <View className="flex-row gap-6">
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={8} onPress={onClose}>
            <Text className="font-semibold text-accent">Cancel</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Save step" accessibilityState={{ disabled: !valid }} disabled={!valid} hitSlop={8} onPress={save}>
            <Text className={valid ? 'font-semibold text-accent' : 'font-semibold text-accent opacity-40'}>Save</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
