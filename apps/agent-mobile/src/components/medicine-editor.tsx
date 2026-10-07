import { Host, Picker } from '@expo/ui';
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { MedicineDraft, medicineToday, type Weekday } from '@zero/agent-core';
import { useImperativeHandle, useState, type Ref } from 'react';
import { Pressable, View } from 'react-native';

import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

const FREQUENCIES = ['Once a day', 'Twice a day', 'Three times a day', 'Four times a day'];
const WEEKDAYS: { day: Weekday; short: string; name: string }[] = [
  { day: 1, short: 'M', name: 'Monday' }, { day: 2, short: 'T', name: 'Tuesday' }, { day: 3, short: 'W', name: 'Wednesday' },
  { day: 4, short: 'T', name: 'Thursday' }, { day: 5, short: 'F', name: 'Friday' }, { day: 6, short: 'S', name: 'Saturday' }, { day: 7, short: 'S', name: 'Sunday' },
];
export type MedicineEditorHandle = { handleBack: () => boolean };
export function MedicineEditorFields({ draft, onChange, disabled = false, error, editorRef }: {
  draft: MedicineDraft; onChange: (draft: MedicineDraft) => void; disabled?: boolean; error?: string | null; editorRef?: Ref<MedicineEditorHandle>;
}) {
  const [description, setDescription] = useState(!!draft.input.instructions);
  const [customizing, setCustomizing] = useState(false);
  const [picker, setPicker] = useState<{ mode: 'date' | 'time'; value: Date; save: (date: Date) => void } | null>(null);
  useImperativeHandle(editorRef, () => ({ handleBack: () => {
    if (picker) { setPicker(null); return true; }
    if (customizing) { setCustomizing(false); return true; }
    return false;
  } }), [picker, customizing]);
  const count = draft.input.doses.length;
  const course = draft.course;
  const endsOn = (() => { try { return draft.endsOn; } catch { return null; } })();
  const pickTime = (slotId: string, key: 'alarmAt' | 'remindAt', time: string) => setPicker({
    mode: 'time', value: new Date(`2000-01-01T${time}:00`),
    save: (date) => onChange(draft.time(slotId, key, `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`)),
  });
  const pickDate = (lastDay: boolean) => setPicker({
    mode: 'date', value: new Date(`${lastDay ? endsOn ?? draft.input.startsOn : draft.input.startsOn}T12:00:00`),
    save: (date) => onChange(lastDay ? draft.withCourse({ kind: 'last-day', on: medicineToday(date) }) : draft.change({ startsOn: medicineToday(date) })),
  });
  return <View className="border-t border-divider">
    {description ? <Input
      accessibilityLabel="Medicine description" placeholder="Description (optional)" multiline editable={!disabled}
      value={draft.input.instructions ?? ''} onChangeText={(instructions) => onChange(draft.change({ instructions }))}
      className="min-h-12 px-screen-x py-3"
    /> : <Pressable accessibilityRole="button" accessibilityLabel="Add description" disabled={disabled} onPress={() => setDescription(true)} className="min-h-12 justify-center px-screen-x"><Text variant="subtitle">Add description</Text></Pressable>}
    <View className="px-screen-x pb-2">
      <Host matchContents><Picker selectedValue={String(count)} enabled={!disabled} onValueChange={(value) => { if (Number(value) <= 4) onChange(draft.frequency(Number(value))); }}>
        {FREQUENCIES.map((label, index) => <Picker.Item key={label} label={label} value={String(index + 1)} />)}
        {count > 4 ? <Picker.Item label={`${count} times a day`} value={String(count)} /> : null}
      </Picker></Host>
    </View>
    <View className="flex-row justify-between px-screen-x pb-2">
      {WEEKDAYS.map(({ day, short, name }) => {
        const checked = draft.input.weekdays.includes(day);
        return <Pressable key={day} accessibilityRole="checkbox" accessibilityLabel={name} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => onChange(draft.toggleWeekday(day))} className="min-h-12 min-w-12 items-center justify-center">
          <View className={`h-9 w-9 items-center justify-center rounded-full ${checked ? 'bg-accent' : 'border border-divider'}`}><Text className={checked ? 'font-semibold text-on-accent' : 'text-foreground-secondary'}>{short}</Text></View>
        </Pressable>;
      })}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Customize medicine schedule" accessibilityState={{ expanded: customizing }} disabled={disabled} onPress={() => setCustomizing((current) => !current)} className="min-h-14 gap-1 px-screen-x pb-4 pt-1">
      <View className="flex-row flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <Text className="font-medium" style={{ fontVariant: ['tabular-nums'] }}>{draft.input.doses.map((slot) => slot.alarmAt).sort().join('   ·   ')}</Text>
        <Text variant="caption" className="text-accent">{customizing ? 'Done' : 'Adjust'}</Text>
      </View>
    </Pressable>
    {customizing ? <View className="border-t border-divider px-screen-x py-3">
      <Text variant="caption">Notification before each dose</Text>
      {draft.input.doses.map((slot, index) => <View key={slot.id} className="border-b border-divider py-1">
        <View className="flex-row items-center justify-between gap-2">
          <Pressable accessibilityRole="button" accessibilityLabel={`Change dose ${index + 1} time, ${slot.alarmAt}`} disabled={disabled} onPress={() => pickTime(slot.id, 'alarmAt', slot.alarmAt)} className="min-h-12 flex-1 flex-row items-center justify-between gap-2">
            <Text>Dose {index + 1}</Text><Text className="font-medium text-accent" style={{ fontVariant: ['tabular-nums'] }}>{slot.alarmAt}</Text>
          </Pressable>
          {count > 1 ? <Pressable accessibilityRole="button" accessibilityLabel={`Remove dose ${index + 1}`} disabled={disabled} onPress={() => onChange(draft.removeTime(slot.id))} className="min-h-12 justify-center px-3"><Text variant="caption">Remove</Text></Pressable> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Change reminder ${index + 1}, ${slot.remindAt}`} disabled={disabled} onPress={() => pickTime(slot.id, 'remindAt', slot.remindAt)} className="min-h-12 flex-row items-center justify-between gap-2"><Text variant="subtitle">Early reminder</Text><Text variant="subtitle" style={{ fontVariant: ['tabular-nums'] }}>{slot.remindAt}</Text></Pressable>
      </View>)}
      {count < 24 ? <Pressable accessibilityRole="button" accessibilityLabel="Add dose time" disabled={disabled} onPress={() => onChange(draft.addTime())} className="min-h-12 justify-center"><Text className="text-accent">Add another time</Text></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Change medicine start day" disabled={disabled} onPress={() => pickDate(false)} className="min-h-12 flex-row items-center justify-between gap-3"><Text>Starts</Text><Text variant="subtitle">{draft.input.startsOn === medicineToday() ? 'Today' : draft.input.startsOn}</Text></Pressable>
      <Host matchContents><Picker selectedValue={course.kind} enabled={!disabled} onValueChange={(kind) => onChange(draft.withCourse(kind === 'days' ? { kind: 'days', days: '10' } : kind === 'last-day' ? { kind: 'last-day', on: endsOn ?? draft.input.startsOn } : { kind: 'ongoing' }))}>
        <Picker.Item label="Ongoing" value="ongoing" /><Picker.Item label="For a number of days" value="days" /><Picker.Item label="Until a date" value="last-day" />
      </Picker></Host>
      {course.kind === 'days' ? <View className="gap-1"><Input accessibilityLabel="Number of days" placeholder="Days" keyboardType="number-pad" editable={!disabled} value={course.days} onChangeText={(days) => onChange(draft.withCourse({ kind: 'days', days }))} className="min-h-12" />{endsOn ? <Text variant="caption">Last day: {endsOn}, inclusive</Text> : null}</View> : null}
      {course.kind === 'last-day' ? <Pressable accessibilityRole="button" accessibilityLabel="Change medicine last day" disabled={disabled} onPress={() => pickDate(true)} className="min-h-12 flex-row items-center justify-between"><Text>Last day</Text><Text className="text-accent">{course.on}</Text></Pressable> : null}
    </View> : <View className="px-screen-x pb-3"><Text variant="caption">{draft.suggested ? 'Notification before each dose and at dose time' : 'Reminders follow your saved times'}</Text></View>}
    {error ? <Text variant="error" selectable className="px-screen-x pb-3">{error}</Text> : null}
    {picker ? <DateTimePicker value={picker.value} mode={picker.mode} is24Hour onChange={(event, date) => { if (event.type === 'set' && date) picker.save(date); setPicker(null); }} /> : null}
  </View>;
}

export function MedicineSaveButton({ busy, disabled, onPress, editing = false }: { busy: boolean; disabled: boolean; onPress: () => void; editing?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Save medicine' : 'Add medicine'} accessibilityState={{ busy, disabled: disabled || busy }} disabled={disabled || busy} onPress={onPress} className={`min-h-12 min-w-12 items-center justify-center rounded-xl bg-accent px-4 ${disabled || busy ? 'opacity-40' : ''}`}><Text className="font-semibold text-on-accent">{busy ? 'Saving…' : editing ? 'Save' : 'Add'}</Text></Pressable>;
}
