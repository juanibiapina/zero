import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { MedicineDraft, medicineDay, medicineEndDate, medicineToday, pillCount, type MedicineSlot, type Weekday } from '@zero/agent-core';
import { useImperativeHandle, useLayoutEffect, useState, type Ref } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

const WEEKDAYS: { day: Weekday; short: string; name: string }[] = [
  { day: 1, short: 'M', name: 'Monday' }, { day: 2, short: 'T', name: 'Tuesday' }, { day: 3, short: 'W', name: 'Wednesday' },
  { day: 4, short: 'T', name: 'Thursday' }, { day: 5, short: 'F', name: 'Friday' }, { day: 6, short: 'S', name: 'Saturday' }, { day: 7, short: 'S', name: 'Sunday' },
];
const HEADS_UP = [{ minutes: 15, label: '15 min' }, { minutes: 30, label: '30 min' }, { minutes: 60, label: '1 hour' }];
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clockOf = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const leadLabel = (minutes: number) => minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}` : minutes > 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
const courseDays = (start: string, end: string) => Math.round((Date.parse(`${end}T12:00:00`) - Date.parse(`${start}T12:00:00`)) / 86_400_000) + 1;
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const sorted = (doses: MedicineSlot[]) => [...doses].sort((a, b) => a.alarmAt.localeCompare(b.alarmAt));

export function Chip({ label, accessibilityLabel = label, selected = false, disabled = false, onPress }: { label: string; accessibilityLabel?: string; selected?: boolean; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} className="min-h-12 justify-center">
    <View className={`min-h-9 justify-center rounded-full px-3.5 ${selected ? 'bg-accent' : 'bg-surface-muted'} ${disabled ? 'opacity-50' : ''}`}>
      <Text className={selected ? 'font-semibold text-on-accent' : 'text-foreground'} style={{ fontVariant: ['tabular-nums'] }}>{label}</Text>
    </View>
  </Pressable>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View className="gap-1 pt-3"><Text variant="caption" className="font-semibold uppercase tracking-wide">{title}</Text>{children}</View>;
}

export type MedicineScheduleHandle = { handleBack: () => boolean };

export function MedicineSchedule({ draft, onChange, disabled = false, presets = false, scheduleRef, onPickerOpenChange }: {
  draft: MedicineDraft;
  onChange: (draft: MedicineDraft) => Promise<void> | void;
  disabled?: boolean;
  presets?: boolean;
  scheduleRef?: Ref<MedicineScheduleHandle>;
  onPickerOpenChange?: (open: boolean) => void;
}) {
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ mode: 'date' | 'time'; value: Date; save: (date: Date) => void } | null>(null);
  useImperativeHandle(scheduleRef, () => ({ handleBack: () => {
    if (picker) { setPicker(null); return true; }
    if (openSlot) { setOpenSlot(null); return true; }
    return false;
  } }), [picker, openSlot]);
  const today = medicineToday();
  const tomorrow = medicineEndDate(today, 2);
  const { doses, weekdays, startsOn } = draft.input;
  const otherStart = startsOn !== today && startsOn !== tomorrow;
  const endsOn = (() => { try { return draft.endsOn; } catch { return null; } })();
  const slot = doses.find((item) => item.id === openSlot) ?? null;
  const pickerOpen = slot != null || picker != null;
  useLayoutEffect(() => { onPickerOpenChange?.(pickerOpen); }, [pickerOpen, onPickerOpenChange]);
  const pickDate = (value: string, save: (day: string) => void) => setPicker({ mode: 'date', value: new Date(`${value}T12:00:00`), save: (date) => save(medicineToday(date)) });
  const days = endsOn ? courseDays(startsOn, endsOn) : 0;
  const setDays = (count: number) => { if (count >= 1) void onChange(draft.withCourse({ kind: 'last-day', on: medicineEndDate(startsOn, count) })); };
  return <View>
    {presets ? <View className="flex-row flex-wrap gap-x-2">
      {[1, 2, 3, 4].map((count) => <Chip key={count} label={`${count}× a day`} accessibilityLabel={count === 1 ? 'Once a day' : `${count} times a day`} selected={doses.length === count} disabled={disabled} onPress={() => void onChange(draft.frequency(count))} />)}
    </View> : null}
    <View className="flex-row flex-wrap gap-x-2">
      {sorted(doses).map((item) => <Chip key={item.id} label={`${item.alarmAt} · ${pillCount(item.amount)}`} accessibilityLabel={`Dose at ${item.alarmAt}, ${pillCount(item.amount)}. Change`} disabled={disabled} onPress={() => setOpenSlot(item.id)} />)}
      {doses.length < 24 ? <Chip label="+ Time" accessibilityLabel="Add dose time" disabled={disabled} onPress={() => void onChange(draft.addTime())} /> : null}
    </View>
    <Section title="Days">
      <View className="flex-row justify-between">
        {WEEKDAYS.map(({ day, short, name }) => {
          const checked = weekdays.includes(day);
          return <Pressable key={day} accessibilityRole="checkbox" accessibilityLabel={name} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => void onChange(draft.toggleWeekday(day))} className="min-h-12 min-w-12 items-center justify-center">
            <View className={`h-9 w-9 items-center justify-center rounded-full ${checked ? 'bg-accent' : 'bg-surface-muted'}`}><Text className={checked ? 'font-semibold text-on-accent' : 'text-foreground-secondary'}>{short}</Text></View>
          </Pressable>;
        })}
      </View>
    </Section>
    <Section title={startsOn < today ? 'Started' : 'Starts'}>
      <View className="flex-row flex-wrap items-center gap-x-2">
        <Chip label="Today" accessibilityLabel="Start today" selected={startsOn === today} disabled={disabled} onPress={() => void onChange(draft.change({ startsOn: today }))} />
        <Chip label="Tomorrow" accessibilityLabel="Start tomorrow" selected={startsOn === tomorrow} disabled={disabled} onPress={() => void onChange(draft.change({ startsOn: tomorrow }))} />
        <Chip label={otherStart ? capitalized(medicineDay(startsOn, today)) : 'Pick a day'} accessibilityLabel={otherStart ? `Change start day, ${medicineDay(startsOn, today)}` : 'Pick a start day'} selected={otherStart} disabled={disabled} onPress={() => pickDate(startsOn, (day) => void onChange(draft.change({ startsOn: day })))} />
      </View>
    </Section>
    <Section title="How long">
      <View className="flex-row flex-wrap items-center gap-x-2">
        <Chip label="Ongoing" selected={!endsOn} disabled={disabled} onPress={() => void onChange(draft.withCourse({ kind: 'ongoing' }))} />
        <Chip label={endsOn ? `Until ${medicineDay(endsOn, today)}` : 'Until…'} accessibilityLabel={endsOn ? `Change last day, ${endsOn}` : 'Set a last day'} selected={!!endsOn} disabled={disabled} onPress={() => endsOn ? pickDate(endsOn, (day) => void onChange(draft.withCourse({ kind: 'last-day', on: day }))) : setDays(10)} />
      </View>
      {endsOn ? <View className="flex-row items-center justify-between">
        <Text variant="subtitle">{days === 1 ? '1 day' : `${days} days`}</Text>
        <Stepper label="days" value={days} min={1} disabled={disabled} onChange={setDays} />
      </View> : null}
    </Section>
    <Sheet open={slot != null} onClose={() => setOpenSlot(null)}>
      {slot ? <DoseForm slot={slot} canRemove={doses.length > 1} disabled={disabled} onClose={() => setOpenSlot(null)}
        onChange={(change) => onChange(change(draft))} onPickTime={(save) => setPicker({ mode: 'time', value: new Date(`2000-01-01T${slot.alarmAt}:00`), save: (date) => save(clockOf(date)) })}
      /> : null}
    </Sheet>
    {picker ? <DateTimePicker value={picker.value} mode={picker.mode} is24Hour onChange={(event, date) => { if (event.type === 'set' && date) picker.save(date); setPicker(null); }} /> : null}
  </View>;
}

export function Stepper({ label, value, min = 1, disabled = false, onChange }: { label: string; value: number; min?: number; disabled?: boolean; onChange: (value: number) => void }) {
  const fewer = disabled || value <= min;
  return <View className="flex-row items-center">
    <Pressable accessibilityRole="button" accessibilityLabel={`Fewer ${label}`} accessibilityState={{ disabled: fewer }} disabled={fewer} onPress={() => onChange(value - 1)} className="min-h-12 min-w-12 items-center justify-center">
      <View className={`h-9 w-9 items-center justify-center rounded-full bg-surface-muted ${fewer ? 'opacity-40' : ''}`}><Text className="text-section text-accent">−</Text></View>
    </Pressable>
    <Text className="min-w-8 text-center font-semibold" style={{ fontVariant: ['tabular-nums'] }}>{value}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`More ${label}`} accessibilityState={{ disabled }} disabled={disabled} onPress={() => onChange(value + 1)} className="min-h-12 min-w-12 items-center justify-center">
      <View className={`h-9 w-9 items-center justify-center rounded-full bg-surface-muted ${disabled ? 'opacity-40' : ''}`}><Text className="text-section text-accent">+</Text></View>
    </Pressable>
  </View>;
}

function DoseForm({ slot, canRemove, disabled, onClose, onChange, onPickTime }: {
  slot: MedicineSlot; canRemove: boolean; disabled: boolean; onClose: () => void;
  onChange: (change: (draft: MedicineDraft) => MedicineDraft) => Promise<void> | void;
  onPickTime: (save: (time: string) => void) => void;
}) {
  const lead = minutesOf(slot.alarmAt) - minutesOf(slot.remindAt);
  const leads = HEADS_UP.some((option) => option.minutes === lead) ? HEADS_UP : [...HEADS_UP, { minutes: lead, label: leadLabel(lead) }].sort((a, b) => a.minutes - b.minutes);
  return <ScrollView className="px-screen-x" keyboardShouldPersistTaps="handled">
    <View className="min-h-14 flex-row items-center justify-between">
      <Text variant="section">Dose</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Change time, ${slot.alarmAt}`} disabled={disabled} onPress={() => onPickTime((time) => void onChange((draft) => draft.time(slot.id, 'alarmAt', time)))} className="min-h-12 justify-center rounded-xl bg-surface-muted px-4">
        <Text className="text-section font-semibold text-accent" style={{ fontVariant: ['tabular-nums'] }}>{slot.alarmAt}</Text>
      </Pressable>
    </View>
    <View className="min-h-14 flex-row items-center justify-between border-t border-divider">
      <Text accessibilityLabel={`Takes ${pillCount(slot.amount)}`}>{slot.amount === 1 ? 'Pill' : 'Pills'}</Text>
      <Stepper label="pills" value={slot.amount} disabled={disabled} onChange={(amount) => void onChange((draft) => draft.amount(slot.id, amount))} />
    </View>
    <View className="border-t border-divider pt-3">
      <Text>Remind me before</Text>
      <View className="flex-row flex-wrap gap-x-2">
        {leads.map((option) => <Chip key={option.minutes} label={option.label} accessibilityLabel={`Remind ${option.label} before`} selected={option.minutes === lead} disabled={disabled} onPress={() => void onChange((draft) => draft.heads(slot.id, option.minutes))} />)}
      </View>
    </View>
    <View className="flex-row items-center justify-between border-t border-divider py-2">
      {canRemove ? <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${slot.alarmAt} dose`} disabled={disabled} onPress={() => { onClose(); void onChange((draft) => draft.removeTime(slot.id)); }} className="min-h-12 justify-center"><Text className="font-medium text-danger">Remove</Text></Pressable> : <View />}
      <Pressable accessibilityRole="button" accessibilityLabel="Done" onPress={onClose} className="min-h-12 justify-center px-2"><Text className="font-semibold text-accent">Done</Text></Pressable>
    </View>
  </ScrollView>;
}

export function MedicineSaveButton({ busy, disabled, onPress }: { busy: boolean; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Add medicine" accessibilityState={{ busy, disabled: disabled || busy }} disabled={disabled || busy} onPress={onPress} className={`min-h-12 min-w-12 items-center justify-center rounded-xl bg-accent px-4 ${disabled || busy ? 'opacity-40' : ''}`}><Text className="font-semibold text-on-accent">{busy ? 'Saving…' : 'Add'}</Text></Pressable>;
}
