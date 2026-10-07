import { Host, Icon } from '@expo/ui';
import { safeRandomUUID } from '@tanstack/db';
import { MedicineDraft, medicineOccurrences, medicineState, medicineToday, parseLocalDay, type Dose, type Medicine } from '@zero/agent-core';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, FlatList, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MedicineEditorFields, MedicineSaveButton, type MedicineEditorHandle } from '@/components/medicine-editor';
import { ScreenHeader } from '@/components/screen-header';
import { TaskEditorSheet } from '@/components/task-editor-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Text } from '@/components/ui/text';
import { Fab } from '@/components/ui/fab';
import { useLocalDay } from '@/lib/local-day';
import { useMedicineReminderNotice } from '@/lib/medicine-reminders';
import { useColor } from '@/lib/theme';
import { useTodoReplica } from '@/lib/todo-replica-hook';

const MEDICINE_ICONS = {
  back: Icon.select({ ios: 'arrow.left', android: import('@expo/material-symbols/arrow_back.xml') }),
  more: Icon.select({ ios: 'ellipsis', android: import('@expo/material-symbols/more_horiz.xml') }),
  collapse: Icon.select({ ios: 'chevron.up', android: import('@expo/material-symbols/keyboard_arrow_up.xml') }),
  expand: Icon.select({ ios: 'chevron.down', android: import('@expo/material-symbols/keyboard_arrow_down.xml') }),
};
function MedicineGlyph({ name }: { name: keyof typeof MEDICINE_ICONS }) {
  const color = useColor('--color-foreground-secondary');
  return <View accessible={false} importantForAccessibility="no-hide-descendants"><Host matchContents><Icon name={MEDICINE_ICONS[name]} size={20} color={color} /></Host></View>;
}
const time = (instant: string) => new Date(instant).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const day = (date: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(parseLocalDay(date));
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function Action({ label, accessibilityLabel = label, onPress, disabled = false, danger = false }: { label: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={disabled} onPress={onPress} className="min-h-12 justify-center py-2"><Text className={danger ? 'font-medium text-danger' : 'font-medium text-accent'}>{label}</Text></Pressable>;
}
function useMedicines() {
  const replica = useTodoReplica();
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => replica?.subscribe(() => listener()) ?? (() => {}), [replica]),
    useCallback(() => replica?.snapshot(), [replica]),
  );
  const today = useLocalDay();
  return { replica, snapshot, medicines: snapshot?.medicines ?? [], doses: snapshot?.doses ?? [], today };
}
function BackToMedicines() {
  return <Pressable accessibilityRole="button" accessibilityLabel="Back to medicines" onPress={() => router.dismissTo('/browse/medicines')} className="min-h-12 flex-row items-center gap-2 px-screen-x"><MedicineGlyph name="back" /><Text variant="subtitle">Medicines</Text></Pressable>;
}
function Page({ title, children }: { title: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <View className="flex-1 bg-background"><ScreenHeader title={title} /><BackToMedicines /><ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}><View className="px-screen-x">{children}</View></ScrollView></View>;
}
export function MedicinesList() {
  const { replica, snapshot, today } = useMedicines();
  return <View className="flex-1 bg-background"><ScreenHeader title="Medicines" backToBrowse />{replica && snapshot ? <MedicineListContent snapshot={snapshot} today={today} /> : <View className="px-screen-x py-6"><Text variant="subtitle">Opening medicines…</Text></View>}</View>;
}
function MedicineListContent({ snapshot, today }: {
  snapshot: NonNullable<ReturnType<typeof useMedicines>['snapshot']>;
  today: string;
}) {
  const insets = useSafeAreaInsets();
  const ripple = useColor('--color-ripple');
  const [adding, setAdding] = useState(false);
  const medicines = [...snapshot.medicines].sort((a, b) => {
    const order = { active: 0, scheduled: 1, paused: 2, ended: 3 };
    return order[medicineState(a, today)] - order[medicineState(b, today)] || a.name.localeCompare(b.name);
  });
  return <View className="flex-1">
    <FlatList
      data={medicines} keyExtractor={(medicine) => medicine.id}
      contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: insets.bottom + 96, flexGrow: 1 }}
      ListHeaderComponent={<View className="px-screen-x"><ReminderNotice />{snapshot.recoveries.filter((entry) => entry.table === 'medicines' || entry.table === 'doses').map((entry) => <Text key={`${entry.table}-${entry.id}`} variant="error">{entry.reason} ({entry.id})</Text>)}</View>}
      ListEmptyComponent={<View className="gap-2 px-screen-x py-8"><Text variant="section">Your medicines, at a glance</Text><Text variant="subtitle">Tap + to add a medicine. Choose how often, and we’ll suggest the times.</Text></View>}
      renderItem={({ item: medicine }) => {
        const state = medicineState(medicine, today);
        const expected = medicineOccurrences(medicine, today);
        const taken = expected.filter((dose) => snapshot.doses.some((item) => item.id === dose.id && item.takenAt)).length;
        const status = state === 'active' ? taken ? `${taken}/${expected.length} taken` : null : state === 'paused' ? 'Paused' : state === 'ended' ? 'Ended' : `Starts ${day(medicine.startsOn)}`;
        return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${medicine.name}`} onPress={() => router.push(`/browse/medicines/${medicine.id}`)} android_ripple={{ color: ripple }} className="min-h-16 gap-1 border-b border-divider px-screen-x py-3">
          <View className="flex-row flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><Text className="min-w-0 flex-1 font-semibold">{medicine.name}</Text>{status ? <Text variant="caption">{status}</Text> : null}</View>
          <Text variant="subtitle" className="text-foreground" style={{ fontVariant: ['tabular-nums'] }}>{medicine.doses.map((slot) => slot.alarmAt).sort().join('   ·   ')}</Text>
          {medicine.instructions ? <Text variant="caption" numberOfLines={1}>{medicine.instructions}</Text> : null}
        </Pressable>;
      }}
    />
    {adding ? <MedicineDrawer onClose={() => setAdding(false)} onSaved={() => setAdding(false)} /> : <Fab label="Add medicine" onPress={() => setAdding(true)} className="absolute right-4" style={{ bottom: insets.bottom + 16 }} />}
  </View>;
}
function ReminderNotice() {
  const notice = useMedicineReminderNotice(useTodoReplica());
  if (!notice) return null;
  return <View accessibilityRole="alert" className="flex-row flex-wrap items-center justify-between gap-x-3 border-b border-divider py-2">
    <Text variant="caption" className="min-w-0 flex-1 text-danger">{notice.message}</Text>
    <Action label={notice.action} disabled={notice.pending} onPress={() => void notice.fix()} />
  </View>;
}
export function MedicineDetail() {
  const params = useLocalSearchParams<{ id: string; dose?: string }>();
  const { replica, snapshot, medicines, doses, today } = useMedicines();
  const medicine = medicines.find((item) => item.id === params.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [undoing, setUndoing] = useState<Dose | null>(null);
  const actionPending = useRef(false);
  const run = async (operation: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setError(null);
    try { await operation(); } catch (cause) { setError(errorText(cause)); }
    finally { actionPending.current = false; setBusy(false); }
  };
  if (!snapshot) return <Page title="Medicine"><Text variant="subtitle">Opening medicine…</Text></Page>;
  if (!medicine || !replica) return <Page title="Medicine"><Text variant="subtitle">This medicine is no longer available.</Text></Page>;
  const state = medicineState(medicine, today);
  const plannedToday = medicineOccurrences(medicine, today);
  const focusedDose = params.dose ? doses.find((dose) => dose.id === params.dose && dose.medicineId === medicine.id) ?? plannedToday.find((dose) => dose.id === params.dose) : undefined;
  const visibleDoses = params.dose ? focusedDose ? [focusedDose] : [] : plannedToday;
  const history = doses.filter((dose) => dose.medicineId === medicine.id).sort((a, b) => b.on.localeCompare(a.on) || a.scheduledAt.localeCompare(b.scheduledAt));
  const remove = () => Alert.alert('Delete medicine?', 'Its dose history will also be removed.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => void run(async () => { await replica.medicines.remove(medicine.id); router.dismissTo('/browse/medicines'); }) }]);
  return <View className="flex-1 bg-background">
    <Page title={medicine.name}>
      {medicine.instructions ? <Text className="pb-2">{medicine.instructions}</Text> : null}
      <View className="flex-row items-center justify-between gap-3 pb-5"><Text variant="subtitle" className="flex-1">{medicine.doses.length === 1 ? 'Once a day' : `${medicine.doses.length} times a day`}{medicine.endsOn ? ` · Through ${day(medicine.endsOn)}` : ''}</Text><Pressable accessibilityRole="button" accessibilityLabel="Medicine options" accessibilityState={{ expanded: options }} onPress={() => setOptions((current) => !current)} className="min-h-12 min-w-12 items-center justify-center"><MedicineGlyph name="more" /></Pressable></View>
      {options ? <View className="border-y border-divider py-2"><Action label="Edit medicine" disabled={busy} onPress={() => setEditing(true)} />{state === 'ended' ? <Action label="Add again" disabled={busy} onPress={() => setCopying(true)} /> : <Action label={medicine.paused ? 'Resume reminders' : 'Pause reminders'} disabled={busy} onPress={() => void run(() => replica.medicines.edit(medicine.id, { ...medicine, paused: !medicine.paused }))} />}<Action label="Delete medicine" danger disabled={busy} onPress={remove} /></View> : null}
      {error ? <Text variant="error" selectable>{error}</Text> : null}
      <Text accessibilityRole="header" variant="section" className="pb-2">{params.dose ? focusedDose ? `Dose · ${day(focusedDose.on)}` : 'This dose is no longer available.' : state === 'active' ? 'Today' : state === 'ended' ? `Ended ${day(medicine.endsOn!)}` : state === 'paused' ? 'Paused' : `Starts ${day(medicine.startsOn)}`}</Text>
      {visibleDoses.map((planned) => {
        const dose = doses.find((item) => item.id === planned.id) ?? planned;
        const slot = medicine.doses.find((candidate) => candidate.id === dose.slotId);
        const actionable = dose.on === today && state === 'active' && !!slot;
        const content = <View className="gap-0.5"><Text className="font-semibold" style={{ fontVariant: ['tabular-nums'] }}>{time(dose.scheduledAt)}</Text><Text variant="caption">{dose.takenAt ? `Taken at ${time(dose.takenAt)}` : slot ? `Early reminder ${slot.remindAt}` : 'Unrecorded'}</Text></View>;
        const rowClass = 'min-h-16 flex-row flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-divider py-3';
        if (dose.takenAt && dose.on === today) {
          const undo = () => { if (!busy) setUndoing(dose); };
          return <Pressable key={dose.id} accessibilityLabel={`${time(dose.scheduledAt)} dose, taken at ${time(dose.takenAt)}`} accessibilityActions={[{ name: 'undo', label: `Undo ${time(dose.scheduledAt)} dose` }]} onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'undo') undo(); }} onLongPress={undo} className={rowClass}>{content}</Pressable>;
        }
        return <View key={dose.id} className={rowClass}>
          {content}
          {!dose.takenAt && actionable ? <Action label="Taken" accessibilityLabel={`Taken ${time(dose.scheduledAt)} dose`} disabled={busy} onPress={() => void run(() => replica.medicines.take(dose))} /> : null}
        </View>;
      })}
      {state !== 'active' && !params.dose ? <Text variant="subtitle" className="py-4">{medicine.doses.map((slot) => slot.alarmAt).sort().join('   ·   ')}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Dose history" accessibilityState={{ expanded: historyOpen }} onPress={() => setHistoryOpen((current) => !current)} className="min-h-14 flex-row items-center justify-between gap-3 pt-4"><Text variant="section">History</Text><MedicineGlyph name={historyOpen ? 'collapse' : 'expand'} /></Pressable>
      {historyOpen ? <View className="pb-5">{!history.length ? <Text variant="subtitle" className="py-3">Your recorded doses will appear here.</Text> : history.map((dose) => <View key={dose.id} className="flex-row flex-wrap justify-between gap-x-4 gap-y-1 border-b border-divider py-3"><Text variant="subtitle">{day(dose.on)} · {time(dose.scheduledAt)}</Text><Text variant="subtitle">{dose.takenAt ? `Taken at ${time(dose.takenAt)}` : 'Not recorded'}</Text></View>)}</View> : null}
    </Page>
    {undoing ? <ConfirmDialog title={`Mark ${time(undoing.scheduledAt)} dose as not taken?`} message="It will show as pending again." cancelLabel="Cancel" confirmLabel="Undo" onCancel={() => setUndoing(null)} onConfirm={() => { const dose = undoing; setUndoing(null); void run(() => replica.medicines.undo(dose.id)); }} /> : null}
    {editing || copying ? <MedicineDrawer key={copying ? 'copy' : medicine.id} source={medicine} copy={copying} onClose={() => { setEditing(false); setCopying(false); }} onSaved={(id) => { setEditing(false); setCopying(false); if (copying) router.replace(`/browse/medicines/${id}`); }} /> : null}
  </View>;
}
function MedicineDrawer({ source, copy = false, onClose, onSaved }: { source?: Medicine; copy?: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const replica = useTodoReplica();
  const [draft, setDraft] = useState(() => MedicineDraft.create(medicineToday(), source, copy));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const pending = useRef(false);
  const creationId = useRef(safeRandomUUID());
  const editor = useRef<MedicineEditorHandle>(null);
  const editing = !!source && !copy;
  const close = () => { if (pending.current) return; if (discard) setDiscard(false); else if (draft.changed) setDiscard(true); else onClose(); };
  const save = async () => {
    if (!replica || pending.current) return;
    let input;
    setError(null);
    try { input = draft.commit(); } catch (cause) { setError(errorText(cause)); return; }
    pending.current = true; setBusy(true);
    try {
      const id = editing ? (await replica.medicines.edit(source.id, input), source.id) : (await replica.medicines.add(input, creationId.current)).id;
      onSaved(id);
    } catch (cause) { setError(errorText(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <TaskEditorSheet open onClose={close} onBack={() => { if (pending.current) return; if (discard) setDiscard(false); else if (!editor.current?.handleBack()) close(); }} dismissLabel="Dismiss medicine editor" draft={draft.input.name} onChangeDraft={(name) => setDraft((current) => current.change({ name }))} onSubmit={() => void save()} placeholder="Name a medicine" inputAccessibilityLabel="Medicine name" inputEditable={!busy}
    context={<View className="px-screen-x pt-3"><Text variant="section">{editing ? 'Edit medicine' : 'Add medicine'}</Text></View>}
    trailing={<MedicineSaveButton busy={busy} editing={editing} disabled={!draft.input.name.trim() || !replica} onPress={() => void save()} />}
    secondaryContent={<MedicineEditorFields editorRef={editor} draft={draft} onChange={(next) => { setDraft(next); setError(null); }} disabled={busy} error={error} />}
    overlay={discard ? <ConfirmDialog title="Discard changes?" message="The changes you've made will not be saved." cancelLabel="Cancel" confirmLabel="Discard" destructive onCancel={() => setDiscard(false)} onConfirm={onClose} /> : null}
  />;
}
