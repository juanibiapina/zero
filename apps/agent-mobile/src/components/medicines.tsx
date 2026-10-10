import { Host, Icon } from '@expo/ui';
import { safeRandomUUID } from '@tanstack/db';
import { DEFAULT_LEAD_DAYS, doseId, MedicineDraft, medicineDay, medicineNextDay, medicineOccurrences, medicineState, medicineToday, parseLocalDay, pillCount, restockWithUndo, supplyLabel, toast, type Dose, type Medicine, type MedicineSlot } from '@zero/agent-core';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, BackHandler, FlatList, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackRow } from '@/components/back-row';
import { Chip, MedicineSaveButton, MedicineSchedule, type MedicineScheduleHandle } from '@/components/medicine-editor';
import { PillCountSheet } from '@/components/pill-count-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { TaskEditorSheet } from '@/components/task-editor-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useLocalDay } from '@/lib/local-day';
import { useMedicineReminderNotice } from '@/lib/medicine-reminders';
import { useColor } from '@/lib/theme';
import { useTodoReplica } from '@/lib/todo-replica-hook';

const MEDICINE_ICONS = {
  more: Icon.select({ ios: 'ellipsis', android: import('@expo/material-symbols/more_horiz.xml') }),
  collapse: Icon.select({ ios: 'chevron.up', android: import('@expo/material-symbols/keyboard_arrow_up.xml') }),
  expand: Icon.select({ ios: 'chevron.down', android: import('@expo/material-symbols/keyboard_arrow_down.xml') }),
};
function MedicineGlyph({ name }: { name: keyof typeof MEDICINE_ICONS }) {
  const color = useColor('--color-foreground-secondary');
  return <View accessible={false} importantForAccessibility="no-hide-descendants"><Host matchContents><Icon name={MEDICINE_ICONS[name]} size={20} color={color} /></Host></View>;
}
const BUY_LEADS = [{ days: 7, label: '1 week' }, { days: 14, label: '2 weeks' }, { days: 30, label: '1 month' }];
const time = (instant: string) => new Date(instant).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const day = (date: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(parseLocalDay(date));
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const sortedSlots = (medicine: Medicine) => [...medicine.doses].sort((a, b) => a.alarmAt.localeCompare(b.alarmAt));
function Action({ label, accessibilityLabel = label, onPress, disabled = false, danger = false }: { label: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={disabled} onPress={onPress} className="min-h-12 justify-center py-2"><Text className={danger ? 'font-medium text-danger' : 'font-medium text-accent'}>{label}</Text></Pressable>;
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <Text accessibilityRole="header" variant="section" className="pb-2 pt-6">{children}</Text>;
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
const BACK_TO_BROWSE = { label: 'Browse', accessibilityLabel: 'Back to Browse', onPress: () => router.dismissTo('/browse') };
const BACK_TO_MEDICINES = { label: 'Medicines', accessibilityLabel: 'Back to medicines', onPress: () => router.dismissTo('/browse/medicines') };
function Page({ title, header, children }: { title: string; header?: ReactNode; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <View className="flex-1 bg-background">{header ? <><BackRow {...BACK_TO_MEDICINES} />{header}</> : <ScreenHeader title={title} back={BACK_TO_MEDICINES} />}<ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}><View className="px-screen-x">{children}</View></ScrollView></View>;
}
function DoseTimes({ medicine }: { medicine: Medicine }) {
  return <View className="flex-row flex-wrap gap-x-4">
    {sortedSlots(medicine).map((slot) => <Text key={slot.id} variant="subtitle" className="text-foreground" style={{ fontVariant: ['tabular-nums'] }}>{`${slot.alarmAt} · ${pillCount(slot.amount)}`}</Text>)}
  </View>;
}
export function MedicinesList() {
  const { replica, snapshot, today } = useMedicines();
  return <View className="flex-1 bg-background"><ScreenHeader title="Medicines" back={BACK_TO_BROWSE} />{replica && snapshot ? <MedicineListContent snapshot={snapshot} today={today} /> : <View className="px-screen-x py-6"><Text variant="subtitle">Opening medicines…</Text></View>}</View>;
}
function listStatus(medicine: Medicine, today: string, doses: Dose[]): string | null {
  const state = medicineState(medicine, today);
  if (state === 'paused') return 'Paused';
  if (state === 'ended') return 'Ended';
  if (state === 'scheduled') return `Starts ${medicineDay(medicine.startsOn, today)}`;
  const expected = medicineOccurrences(medicine, today);
  if (!expected.length) {
    const next = medicineNextDay(medicine, today);
    return next ? `Next dose ${medicineDay(next, today)}` : 'No more doses';
  }
  const taken = expected.filter((dose) => doses.some((item) => item.id === dose.id && item.takenAt)).length;
  return taken ? `${taken}/${expected.length} taken` : null;
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
        const status = listStatus(medicine, today, snapshot.doses);
        return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${medicine.name}`} onPress={() => router.push(`/browse/medicines/${medicine.id}`)} android_ripple={{ color: ripple }} className="min-h-16 gap-1 border-b border-divider px-screen-x py-3">
          <View className="flex-row flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><Text className="min-w-0 flex-1 font-semibold">{medicine.name}</Text>{status ? <Text variant="caption">{status}</Text> : null}</View>
          <DoseTimes medicine={medicine} />
          {medicine.instructions ? <Text variant="caption" numberOfLines={1}>{medicine.instructions}</Text> : null}
        </Pressable>;
      }}
    />
    <MedicineDrawer open={adding} onOpen={() => setAdding(true)} onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); router.push(`/browse/medicines/${id}`); }} />
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
function PillDots({ amount }: { amount: number }) {
  return <View accessible={false} importantForAccessibility="no-hide-descendants" className="h-3 flex-row items-center gap-1">
    {Array.from({ length: Math.min(amount, 4) }, (_, index) => <View key={index} className="h-2.5 w-2.5 rounded-full bg-accent" />)}
    {amount > 4 ? <Text variant="caption">+{amount - 4}</Text> : null}
  </View>;
}
function DoseTile({ dose, slot, actionable, highlighted, disabled, onTake, onUndo }: {
  dose: Dose; slot: MedicineSlot | undefined; actionable: boolean; highlighted: boolean; disabled: boolean;
  onTake: () => void; onUndo: () => void;
}) {
  const at = time(dose.scheduledAt);
  const amount = slot?.amount ?? 1;
  const tile = 'min-h-24 min-w-28 flex-1 gap-1.5 rounded-2xl p-3';
  const body = (status: string) => <>
    <Text className="text-section font-semibold" style={{ fontVariant: ['tabular-nums'] }}>{at}</Text>
    <PillDots amount={amount} />
    <Text variant="caption" className={dose.takenAt ? 'text-foreground' : undefined}>{status}</Text>
  </>;
  if (dose.takenAt) {
    const status = `✓ Taken at ${time(dose.takenAt)}`;
    if (!actionable) return <View accessible accessibilityLabel={`${at} dose, taken at ${time(dose.takenAt)}`} className={`${tile} bg-surface-muted`}>{body(status)}</View>;
    return <Pressable accessibilityLabel={`${at} dose, taken at ${time(dose.takenAt)}`} accessibilityHint="Long press to undo" accessibilityActions={[{ name: 'undo', label: `Undo ${at} dose` }]} onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'undo') onUndo(); }} onLongPress={onUndo} className={`${tile} bg-surface-muted`}>{body(status)}</Pressable>;
  }
  if (!actionable) return <View accessible accessibilityLabel={`${at} dose, ${pillCount(amount)}`} className={`${tile} border border-divider`}>{body(pillCount(amount))}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Take ${at} dose, ${pillCount(amount)}`} accessibilityState={{ selected: highlighted, disabled }} disabled={disabled} onPress={onTake} className={`${tile} border-2 border-accent ${highlighted ? 'bg-surface-muted' : ''}`}>{body(`Tap when you take ${pillCount(amount)}`)}</Pressable>;
}
export function MedicineDetail() {
  const params = useLocalSearchParams<{ id: string; dose?: string; slot?: string; date?: string }>();
  const { replica, snapshot, medicines, doses, today } = useMedicines();
  const medicine = medicines.find((item) => item.id === params.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const [undoing, setUndoing] = useState<Dose | null>(null);
  const [counting, setCounting] = useState<'restock' | 'count' | null>(null);
  const actionPending = useRef(false);
  const latestMedicine = useRef(medicine);
  useLayoutEffect(() => { latestMedicine.current = medicine; });
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
  const nextDay = state === 'active' && !plannedToday.length ? medicineNextDay(medicine, today) : null;
  const focus = params.slot && params.date ? doseId(medicine.id, params.slot, params.date) : params.dose;
  const focusedDose = focus ? doses.find((dose) => dose.id === focus && dose.medicineId === medicine.id) ?? plannedToday.find((dose) => dose.id === focus) : undefined;
  const pastFocus = !!focus && (!focusedDose || focusedDose.on !== today);
  const tiles = pastFocus ? focusedDose ? [focusedDose] : [] : nextDay ? medicineOccurrences(medicine, nextDay) : plannedToday;
  const heading = pastFocus ? focusedDose ? `Dose · ${day(focusedDose.on)}` : 'This dose is no longer available.'
    : nextDay ? `Next dose ${medicineDay(nextDay, today)}`
    : state === 'active' ? plannedToday.length ? 'Today' : 'No more doses'
    : state === 'ended' ? `Ended ${day(medicine.endsOn!)}` : state === 'paused' ? 'Paused' : `Starts ${medicineDay(medicine.startsOn, today)}`;
  const history = doses.filter((dose) => dose.medicineId === medicine.id).sort((a, b) => b.on.localeCompare(a.on) || a.scheduledAt.localeCompare(b.scheduledAt));
  const draft = MedicineDraft.create(today, medicine);
  const apply = (next: MedicineDraft) => run(() => replica.medicines.edit(medicine.id, next.commit()));
  const take = (dose: Dose) => run(async () => {
    await replica.medicines.take(dose);
    toast(`${time(dose.scheduledAt)} dose taken`, { id: 'undo', action: { label: 'Undo', onPress: () => { replica.medicines.undo(dose.id).catch((cause) => setError(errorText(cause))); } } });
  });
  const remove = () => Alert.alert('Delete medicine?', 'Its dose history will also be removed.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => void run(async () => { await replica.medicines.remove(medicine.id); router.dismissTo('/browse/medicines'); }) }]);
  const saveText = (fields: { name: string; instructions: string | null }) => (async () => {
    setError(null);
    await replica.medicines.edit(medicine.id, MedicineDraft.create(today, latestMedicine.current ?? medicine).change(fields).commit());
  })().catch((cause) => setError(errorText(cause)));
  const supply = medicine.supply;
  const buyLeads = !supply || BUY_LEADS.some((lead) => lead.days === supply.leadDays) ? BUY_LEADS : [...BUY_LEADS, { days: supply.leadDays, label: `${supply.leadDays} days` }].sort((a, b) => a.days - b.days);
  return <View className="flex-1 bg-background">
    <Page title={medicine.name} header={<MedicineIdentity key={medicine.id} medicine={medicine} onSave={saveText}
      options={<Pressable accessibilityRole="button" accessibilityLabel="Medicine options" accessibilityState={{ expanded: options }} onPress={() => setOptions((current) => !current)} className="min-h-12 min-w-12 items-center justify-center"><MedicineGlyph name="more" /></Pressable>} />}>
      {options ? <View className="border-y border-divider py-2">{state === 'ended' ? <Action label="Add again" disabled={busy} onPress={() => setCopying(true)} /> : <Action label={medicine.paused ? 'Resume reminders' : 'Pause reminders'} disabled={busy} onPress={() => void run(() => replica.medicines.edit(medicine.id, { ...medicine, paused: !medicine.paused }))} />}<Action label="Delete medicine" danger disabled={busy} onPress={remove} /></View> : null}
      {error ? <Text variant="error" selectable className="pt-2">{error}</Text> : null}
      <Text accessibilityRole="header" variant="section" className="pb-3 pt-2">{heading}</Text>
      {tiles.length ? <View className="flex-row flex-wrap gap-3">
        {tiles.map((planned) => {
          const dose = doses.find((item) => item.id === planned.id) ?? planned;
          const slot = medicine.doses.find((candidate) => candidate.id === dose.slotId);
          const actionable = dose.on === today && state === 'active' && !!slot;
          return <DoseTile key={dose.id} dose={dose} slot={slot} actionable={actionable} highlighted={dose.id === focus} disabled={busy}
            onTake={() => void take(dose)} onUndo={() => { if (!busy) setUndoing(dose); }} />;
        })}
      </View> : null}
      <SectionTitle>Schedule</SectionTitle>
      {state === 'ended' ? <DoseTimes medicine={medicine} /> : <MedicineSchedule draft={draft} onChange={apply} disabled={busy} />}
      <SectionTitle>Pills</SectionTitle>
      <View className="flex-row flex-wrap items-center justify-between gap-x-4">
        <Text className="min-w-0 flex-1" style={{ fontVariant: ['tabular-nums'] }}>{supplyLabel(medicine) ?? 'Not counted yet'}</Text>
        <View className="flex-row gap-4">
          <Action label="Restock" disabled={busy} onPress={() => setCounting('restock')} />
          <Action label={supply ? 'Recount' : 'Count pills'} disabled={busy} onPress={() => setCounting('count')} />
        </View>
      </View>
      {supply ? <View className="pt-1">
        <Text variant="subtitle">Remind me to buy more</Text>
        <View className="flex-row flex-wrap gap-x-2">
          {buyLeads.map((lead) => <Chip key={lead.days} label={`${lead.label} before`} accessibilityLabel={`Remind me to buy ${lead.label} before they run out`} selected={lead.days === supply.leadDays} disabled={busy}
            onPress={() => void run(() => replica.medicines.setSupply(medicine.id, { pillsLeft: supply.pillsLeft, leadDays: lead.days }))} />)}
        </View>
      </View> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Dose history" accessibilityState={{ expanded: historyOpen }} onPress={() => setHistoryOpen((current) => !current)} className="min-h-14 flex-row items-center justify-between gap-3 pt-6"><Text variant="section">History</Text><MedicineGlyph name={historyOpen ? 'collapse' : 'expand'} /></Pressable>
      {historyOpen ? <View className="pb-5">{!history.length ? <Text variant="subtitle" className="py-3">Your recorded doses will appear here.</Text> : history.map((dose) => <View key={dose.id} className="flex-row flex-wrap justify-between gap-x-4 gap-y-1 border-b border-divider py-3"><Text variant="subtitle">{day(dose.on)} · {time(dose.scheduledAt)}</Text><Text variant="subtitle">{dose.takenAt ? `Taken at ${time(dose.takenAt)}` : 'Not recorded'}</Text></View>)}</View> : null}
    </Page>
    {undoing ? <ConfirmDialog title={`Mark ${time(undoing.scheduledAt)} dose as not taken?`} message="It will show as pending again." cancelLabel="Cancel" confirmLabel="Undo" onCancel={() => setUndoing(null)} onConfirm={() => { const dose = undoing; setUndoing(null); void run(() => replica.medicines.undo(dose.id)); }} /> : null}
    <PillCountSheet open={counting === 'restock'} title="How many pills did you get?" initial={supply?.refill ?? null} onClose={() => setCounting(null)} onSave={(amount) => { setCounting(null); void restockWithUndo({ replica, medicineId: medicine.id, amount, onError: setError }); }} />
    <PillCountSheet open={counting === 'count'} title="How many pills do you have now?" initial={supply?.pillsLeft ?? null} min={0} onClose={() => setCounting(null)} onSave={(pillsLeft) => { setCounting(null); void run(() => replica.medicines.setSupply(medicine.id, { pillsLeft, leadDays: supply?.leadDays ?? DEFAULT_LEAD_DAYS })); }} />
    <MedicineDrawer open={copying} source={medicine} onClose={() => setCopying(false)} onSaved={(id) => { setCopying(false); router.replace(`/browse/medicines/${id}`); }} />
  </View>;
}
function MedicineIdentity({ medicine, onSave, options }: {
  medicine: Medicine;
  onSave: (fields: { name: string; instructions: string | null }) => Promise<void>;
  options: ReactNode;
}) {
  const [name, setName] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const latest = useRef({ medicine, name, notes, onSave });
  useLayoutEffect(() => { latest.current = { medicine, name, notes, onSave }; });
  const commit = useCallback(() => {
    const { medicine: stored, name: editedName, notes: editedNotes, onSave: save } = latest.current;
    const fields = { name: editedName?.trim() || stored.name, instructions: editedNotes === null ? stored.instructions : editedNotes.trim() || null };
    const settle = () => {
      setName((current) => current === editedName ? null : current);
      setNotes((current) => current === editedNotes ? null : current);
    };
    if (fields.name === stored.name && fields.instructions === stored.instructions) settle();
    else void save(fields).finally(settle);
  }, []);
  useEffect(() => commit, [commit]);
  return <View className="px-screen-x pb-1">
    <View className="min-h-12 flex-row items-center gap-2">
      <Input value={name ?? medicine.name} onChangeText={setName} onBlur={commit} onSubmitEditing={commit} returnKeyType="done" blurOnSubmit
        accessibilityLabel="Medicine name" className="min-w-0 flex-1 text-title" />
      {options}
    </View>
    <Input value={notes ?? medicine.instructions ?? ''} onChangeText={setNotes} onBlur={commit} multiline
      placeholder="Notes, like “after food”" accessibilityLabel="Medicine description" className="text-subtitle" />
  </View>;
}
function MedicineDrawer({ open, source, onOpen, onClose, onSaved }: { open: boolean; source?: Medicine; onOpen?: () => void; onClose: () => void; onSaved: (id: string) => void }) {
  const replica = useTodoReplica();
  const [draft, setDraft] = useState(() => MedicineDraft.create(medicineToday(), source, !!source));
  const [notesOpen, setNotesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creationId, setCreationId] = useState(safeRandomUUID);
  const [wasOpen, setWasOpen] = useState(open);
  const pending = useRef(false);
  const schedule = useRef<MedicineScheduleHandle>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(MedicineDraft.create(medicineToday(), source, !!source));
      setNotesOpen(false); setError(null); setDiscard(false); setCreationId(safeRandomUUID());
    }
  }
  const description = notesOpen || !!draft.input.instructions;
  const close = () => { if (pending.current) return; if (discard) setDiscard(false); else if (draft.changed) setDiscard(true); else onClose(); };
  const back = () => { if (pending.current) return; if (discard) setDiscard(false); else if (!schedule.current?.handleBack()) close(); };
  const onHardwareBack = useEffectEvent(back);
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onHardwareBack(); return true; });
    return () => sub.remove();
  }, [open]);
  const save = async () => {
    if (!replica || pending.current) return;
    let input;
    setError(null);
    try { input = draft.commit(); } catch (cause) { setError(errorText(cause)); return; }
    pending.current = true; setBusy(true);
    try {
      onSaved((await replica.medicines.add(input, creationId)).id);
    } catch (cause) { setError(errorText(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const change = (next: MedicineDraft) => { setDraft(next); setError(null); };
  return <TaskEditorSheet open={open} onOpen={onOpen} collapsedFabLabel="Add medicine" inline autoFocus selectTextOnFocus={!!source} onClose={close} dismissLabel="Dismiss medicine editor" draft={draft.input.name} onChangeDraft={(name) => setDraft((current) => current.change({ name }))} onSubmit={() => void save()} placeholder="Name a medicine" inputAccessibilityLabel="Medicine name" inputEditable={!busy} holdPosition={pickerOpen}
    context={<View className="px-screen-x pt-3"><Text variant="section">Add medicine</Text></View>}
    trailing={<MedicineSaveButton busy={busy} disabled={!draft.input.name.trim() || !replica} onPress={() => void save()} />}
    secondaryContent={<View className="border-t border-divider">
      {description ? <Input
        accessibilityLabel="Medicine description" placeholder="Notes, like “after food”" multiline editable={!busy}
        value={draft.input.instructions ?? ''} onChangeText={(instructions) => change(draft.change({ instructions }))}
        className="min-h-12 px-screen-x py-3"
      /> : <Pressable accessibilityRole="button" accessibilityLabel="Add description" disabled={busy} onPress={() => setNotesOpen(true)} className="min-h-12 justify-center px-screen-x"><Text variant="subtitle">Add notes</Text></Pressable>}
      <View className="px-screen-x pb-3"><MedicineSchedule draft={draft} onChange={change} disabled={busy} presets scheduleRef={schedule} onPickerOpenChange={setPickerOpen} /></View>
      {error ? <Text variant="error" selectable className="px-screen-x pb-3">{error}</Text> : null}
    </View>}
    overlay={discard ? <ConfirmDialog title="Discard changes?" message="The changes you've made will not be saved." cancelLabel="Cancel" confirmLabel="Discard" destructive onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); onClose(); }} /> : null}
  />;
}
