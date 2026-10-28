import { Host, Icon } from '@expo/ui';
import { messageOf, toast, type NightStep, type NightView, type TaskdoReplica } from '@zero/agent-core';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import ReorderableList, { useReorderableDrag, type ReorderableListReorderEvent } from 'react-native-reorderable-list';
import { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useQuickAdd } from '@/components/quick-add-composer';
import { ScreenHeader } from '@/components/screen-header';
import { Input } from '@/components/ui/input';
import { CheckCircle } from '@/components/ui/list-row';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useNightRoutine } from '@/lib/night-routine';
import { useColor } from '@/lib/theme';

import { lockScreen } from '../../modules/screen-lock';

const NIGHT_ROUTINE_HREF = '/browse/night-routine';
const backToBrowse = () => router.dismissTo('/browse');
const backToHome = () => {
  router.dismissTo('/browse');
  router.navigate('/');
};
const BACK_TO_BROWSE = { label: 'Browse', accessibilityLabel: 'Back to Browse', onPress: backToBrowse };
const BACK_TO_HOME = { label: 'Home', accessibilityLabel: 'Back to Home', onPress: backToHome };

const timeOf = (iso: string) => {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

export function NightRoutineButton() {
  const { view } = useNightRoutine();
  if (!view?.showIcon) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Night routine"
      onPress={() => router.navigate({ pathname: NIGHT_ROUTINE_HREF, params: { from: 'home' } }, { withAnchor: true })}
      className="h-12 w-12 items-center justify-center rounded-full"
    >
      <Text className="text-[22px]">🌙</Text>
    </Pressable>
  );
}

export function NightRoutineScreen() {
  const { replica, view } = useNightRoutine();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const fromHome = from === 'home';
  const back = fromHome ? BACK_TO_HOME : BACK_TO_BROWSE;
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Night routine" back={back} />
      {replica && view ? (
        <NightRoutineContent replica={replica} view={view} onSystemBack={fromHome ? backToHome : null} onLeave={back.onPress} />
      ) : (
        <Text variant="subtitle" className="px-screen-x py-6">Opening your night routine…</Text>
      )}
    </View>
  );
}

function NightRoutineContent({ replica, view, onSystemBack, onLeave }: {
  replica: TaskdoReplica;
  view: NightView;
  onSystemBack: (() => void) | null;
  onLeave: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NightStep | null>(null);
  const [showDone, setShowDone] = useState(false);
  const closed = view.state === 'closed';
  const routine = replica.nightRoutine;
  const fail = useCallback((cause: unknown) => setError(messageOf(cause)), []);

  const add = useQuickAdd({ replica, surface: { kind: 'night-routine' }, onError: setError });
  const handleAddBack = add.handleBack;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (handleAddBack()) return true;
      if (!onSystemBack) return false;
      onSystemBack();
      return true;
    });
    return () => sub.remove();
  }, [handleAddBack, onSystemBack]);

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
      (night) => {
        // The page is gone by the time Undo runs, so an Undo failure shows as a toast.
        toast('Good night', { id: 'undo', action: { label: 'Undo', onPress: () => { routine.undoBed(night).catch((cause) => toast(messageOf(cause))); } } });
        onLeave();
        lockScreen();
      },
      fail,
    );
  }, [routine, fail, onLeave]);

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
      <StepSheet
        step={editing}
        onClose={() => setEditing(null)}
        onRename={(step, text) => { setEditing(null); setError(null); routine.renameStep(step.id, text).catch(fail); }}
        onRemove={(step) => { setEditing(null); setError(null); routine.removeStep(step.id).catch(fail); }}
      />
      {closed || add.isOpen ? null : <GoingToBedButton onPress={goToBed} />}
      {closed ? null : add.element}
    </>
  );
}

const BEDTIME_ICON = Icon.select({ ios: 'bed.double', android: import('@expo/material-symbols/bedtime.xml') });

const FAB_SIZE = 56;
const FAB_EDGE_GAP = 24;
const FAB_SPACING = 16;

function GoingToBedButton({ onPress }: { onPress: () => void }) {
  const accent = useColor('--color-accent');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Going to bed"
      onPress={onPress}
      className="items-center justify-center rounded-full bg-surface shadow-raised"
      style={{
        position: 'absolute',
        right: FAB_EDGE_GAP + FAB_SIZE + FAB_SPACING,
        bottom: FAB_EDGE_GAP,
        width: FAB_SIZE,
        height: FAB_SIZE,
      }}
    >
      <View accessible={false} importantForAccessibility="no-hide-descendants">
        <Host matchContents><Icon name={BEDTIME_ICON} size={24} color={accent} /></Host>
      </View>
    </Pressable>
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
