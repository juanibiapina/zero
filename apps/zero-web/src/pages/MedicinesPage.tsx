import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { DEFAULT_LEAD_DAYS, MedicineDraft, intakeTime, medicineCadence, restockWithUndo, supplyLabel, medicineEndDate, medicineDay, medicineLastDoseAt, medicineNextDay, medicineOccurrences, pillCount, medicineState, medicineToday, type Medicine, type MedicineInput, type TaskdoReplica, type Dose, type Intake, type Weekday } from "@zero/agent-core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { PillCountSheet } from "@/components/pill-count-sheet";
import { useTodoData } from "@/lib/todo-data";
import { useLocalDay } from "@/lib/local-day";

const time = (instant: string) => new Date(instant).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const WEEKDAYS: [Weekday, string][] = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [7, "Sunday"]];
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function MedicineForm({ replica, source, onSaved }: { replica: TaskdoReplica; source?: Medicine; onSaved: (id: string) => void }) {
  const [draft, setDraft] = useState<MedicineInput>(() => MedicineDraft.create(medicineToday(), source).input);
  const [endMode, setEndMode] = useState<"ongoing" | "last-day" | "days" | "until-empty">(source?.untilEmpty ? "until-empty" : source?.endsOn ? "last-day" : "ongoing");
  const [days, setDays] = useState("10"); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const initialPills = source?.supply ? String(source.supply.pillsLeft) : "";
  const initialLead = String(source?.supply?.leadDays ?? DEFAULT_LEAD_DAYS);
  const [pills, setPills] = useState(initialPills); const [lead, setLead] = useState(initialLead);
  const [asNeeded, setAsNeeded] = useState(!!source?.asNeeded);
  const untilEmpty = !asNeeded && endMode === "until-empty";
  const end = (() => { try { return endMode === "ongoing" || untilEmpty ? null : endMode === "days" ? medicineEndDate(draft.startsOn, Number(days)) : draft.endsOn ?? draft.startsOn; } catch { return null; } })();
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const value = asNeeded ? MedicineDraft.create(medicineToday(), draft).withCourse({ kind: "as-needed", pillsLeft: null }).commit()
        : { ...draft, instructions: draft.instructions?.trim() || null, untilEmpty,
          endsOn: untilEmpty ? draft.endsOn : endMode === "days" ? medicineEndDate(draft.startsOn, Number(days)) : end };
      const count = pills.trim();
      if (count && !/^\d+$/.test(count)) throw new Error("Enter the number of pills you have");
      if (untilEmpty && !count) throw new Error("Count your pills first");
      if (count && !untilEmpty && !/^\d+$/.test(lead.trim())) throw new Error("Enter a whole number of days");
      const editing = !!source;
      const counted = untilEmpty ? Number(count) : undefined;
      const id = editing ? (await replica.medicines.edit(source.id, value, counted), source.id) : (await replica.medicines.add(value, undefined, counted)).id;
      const supplyChanged = pills !== initialPills || lead !== initialLead;
      if (!untilEmpty && supplyChanged && count) await replica.medicines.setSupply(id, { pillsLeft: Number(count), leadDays: Number(lead.trim()) });
      else if (!untilEmpty && supplyChanged && editing) await replica.medicines.clearSupply(id);
      onSaved(id);
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex flex-col gap-5">
    <fieldset disabled={busy} className="flex flex-col gap-4"><legend className="sr-only">Medicine details</legend>
      <label className="flex flex-col gap-2">Name<Input aria-label="Medicine name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
      <label className="flex flex-col gap-2">Instructions<Input aria-label="Medicine instructions" placeholder="1 pill after food" value={draft.instructions ?? ""} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
      {source ? null : <fieldset className="flex flex-col gap-2"><legend className="mb-2 font-semibold">When you take it</legend><div className="flex flex-wrap gap-3">
        <label className="flex min-h-10 items-center gap-2"><input type="radio" name="medicine-kind" checked={!asNeeded} onChange={() => setAsNeeded(false)} />On a schedule</label>
        <label className="flex min-h-10 items-center gap-2"><input type="radio" name="medicine-kind" checked={asNeeded} onChange={() => setAsNeeded(true)} />As needed</label>
      </div>{asNeeded ? <p className="text-sm text-muted-foreground">No reminders. Press Take each time you take it.</p> : null}</fieldset>}
      {asNeeded ? null : <>
      <fieldset className="flex flex-col gap-3"><legend className="mb-2 font-semibold">Daily doses</legend>
        {draft.doses.map((dose, index) => <div key={dose.id} className="flex flex-col gap-2 border-b pb-4">
          <div className="flex items-center justify-between"><span>Dose {index + 1}</span>{draft.doses.length > 1 ? <Button type="button" variant="ghost" onClick={() => setDraft({ ...draft, doses: draft.doses.filter((item) => item.id !== dose.id) })}>Remove dose {index + 1}</Button> : null}</div>
          <div className="flex gap-3"><label className="flex flex-1 flex-col gap-1">Alarm<Input type="time" aria-label={`Alarm ${index + 1}`} value={dose.alarmAt} onChange={(event) => setDraft({ ...draft, doses: draft.doses.map((item) => item.id === dose.id ? { ...item, alarmAt: event.target.value } : item) })} required /></label>
            <label className="flex flex-1 flex-col gap-1">Remind from<Input type="time" aria-label={`Remind from ${index + 1}`} value={dose.remindAt} onChange={(event) => setDraft({ ...draft, doses: draft.doses.map((item) => item.id === dose.id ? { ...item, remindAt: event.target.value } : item) })} required /></label>
            <label className="flex w-24 flex-col gap-1">Pills<Input type="number" min={1} step={1} aria-label={`Pills for dose ${index + 1}`} value={dose.amount} onChange={(event) => setDraft(MedicineDraft.create(medicineToday(), draft).amount(dose.id, Number(event.target.value)).input)} required /></label></div>
        </div>)}
        <Button type="button" variant="outline" disabled={draft.doses.length >= 24} onClick={() => setDraft(MedicineDraft.create(medicineToday(), draft).addTime().input)}>Add dose time</Button>
      </fieldset>
      <fieldset className="flex flex-col gap-2"><legend className="mb-2 font-semibold">Days</legend><div className="flex flex-wrap gap-3">{WEEKDAYS.map(([day, name]) => <label key={day} className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={draft.weekdays.includes(day)} onChange={() => setDraft(MedicineDraft.create(medicineToday(), draft).toggleWeekday(day).input)} />{name}</label>)}</div></fieldset>
      <label className="flex flex-col gap-2">Starts<Input type="date" value={draft.startsOn} onChange={(event) => setDraft({ ...draft, startsOn: event.target.value })} required /></label>
      <fieldset className="flex flex-col gap-2"><legend>Ends</legend><div className="flex flex-wrap gap-3">{(["ongoing", "last-day", "days", "until-empty"] as const).map((mode) => <label key={mode} className="flex min-h-10 items-center gap-2"><input type="radio" name="end-mode" checked={endMode === mode} onChange={() => setEndMode(mode)} />{mode === "ongoing" ? "Ongoing" : mode === "days" ? "Number of days" : mode === "until-empty" ? "Until pills run out" : "Last day"}</label>)}</div></fieldset>
      {endMode === "days" ? <label className="flex flex-col gap-2">Number of days<Input type="number" min={1} max={36500} step={1} value={days} onChange={(event) => setDays(event.target.value)} required /></label> : null}
      {endMode === "last-day" ? <label className="flex flex-col gap-2">Last day<Input type="date" min={draft.startsOn} value={end ?? draft.startsOn} onChange={(event) => setDraft({ ...draft, endsOn: event.target.value })} required /></label> : null}
      {endMode === "days" && end ? <p className="text-sm text-muted-foreground">Last day: {end}, inclusive</p> : null}
      </>}
      <fieldset className="flex flex-col gap-3"><legend className="mb-2 font-semibold">Supply</legend>
        <label className="flex flex-col gap-2">Pills you have<Input type="number" min={untilEmpty ? 1 : 0} step={1} aria-label="Pills you have" placeholder={untilEmpty ? undefined : "Optional"} value={pills} onChange={(event) => setPills(event.target.value)} required={untilEmpty} /></label>
        {pills.trim() && !untilEmpty && !asNeeded ? <label className="flex flex-col gap-2">Remind me to buy, days before they run out<Input type="number" min={0} step={1} aria-label="Days before running out" value={lead} onChange={(event) => setLead(event.target.value)} required /></label> : null}
      </fieldset>
    </fieldset>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save medicine"}</Button>
  </form>;
}

export function MedicinesPage() {
  const { replica } = useTodoData(); const navigate = useNavigate(); const { id } = useParams();
  const [search, setSearch] = useSearchParams();
  const [snapshot, setSnapshot] = useState(() => replica?.snapshot());
  useEffect(() => replica?.subscribe(setSnapshot), [replica]);
  const today = useLocalDay(); const medicine = snapshot?.medicines.find((item) => item.id === id);
  const [editor, setEditor] = useState<"new" | "edit" | null>(search.has("new") ? "new" : null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<string | null>(null); const [confirmDelete, setConfirmDelete] = useState(false);
  const [counting, setCounting] = useState<"restock" | "count" | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [takeAmount, setTakeAmount] = useState<{ id: string; value: string } | null>(null); const [lastIntake, setLastIntake] = useState<Intake | null>(null);
  const run = async (operation: () => Promise<void>) => { setError(null); setBusy(true); try { await operation(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  const take = (dose: Dose) => void run(async () => { await replica!.medicines.take(dose); setUndo(dose.id); });
  if (!replica || !snapshot) return <p className="p-6">Opening medicines…</p>;
  const archived = !!medicine?.archivedAt;
  const scheduled = snapshot.medicines.filter((item) => !item.archivedAt && !item.asNeeded);
  const asNeeded = snapshot.medicines.filter((item) => !item.archivedAt && item.asNeeded);
  const lastTaken = (medicineId: string) => snapshot.intakes.find((intake) => intake.medicineId === medicineId);
  const intakes = medicine ? snapshot.intakes.filter((intake) => intake.medicineId === medicine.id) : [];
  const amount = medicine && takeAmount?.id === medicine.id ? takeAmount.value : String(intakes[0]?.amount ?? 1);
  const takeAsNeeded = (item: Medicine) => void run(async () => {
    if (!/^\d+$/.test(amount.trim()) || Number(amount) < 1) throw new Error("Take at least one pill");
    setLastIntake(await replica.medicines.takeAsNeeded(item.id, Number(amount)));
  });
  const archivedList = snapshot.medicines.filter((item) => item.archivedAt);
  const row = (item: Medicine) => {
    if (item.asNeeded) {
      const taken = lastTaken(item.id);
      return <Link key={item.id} to={`/medicines/${item.id}`} className="flex min-h-12 flex-col gap-1 border-b py-3"><span className="font-semibold">{item.name}</span><span className="text-sm text-muted-foreground">{[taken ? `Taken ${intakeTime(taken.takenAt, today)}` : "Not taken yet", item.supply ? `${pillCount(item.supply.pillsLeft)} left` : null].filter(Boolean).join(" · ")}</span></Link>;
    }
    const expected = medicineOccurrences(item, today); const taken = expected.filter((dose) => snapshot.doses.some((entry) => entry.id === dose.id && entry.takenAt)).length;
    const state = medicineState(item, today); const next = state === "active" && !expected.length ? medicineNextDay(item, today) : null;
    return <Link key={item.id} to={`/medicines/${item.id}`} className="flex min-h-12 flex-col gap-1 border-b py-3"><span className="font-semibold">{item.name}</span><span className="text-sm text-muted-foreground">{[...item.doses].sort((a, b) => a.alarmAt.localeCompare(b.alarmAt)).map((dose) => `${dose.alarmAt} (${pillCount(dose.amount)})`).join(" · ")} · {next ? `Next dose ${medicineDay(next, today)}` : state === "active" && !expected.length ? "No more doses" : state === "active" ? `${taken} of ${expected.length} taken` : state}</span></Link>;
  };
  return <main className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6 sm:px-6">
    <header className="flex items-center justify-between gap-3"><h1 className="text-2xl font-semibold">{medicine?.name ?? "Medicines"}</h1>{archived ? null : <Button variant="outline" onClick={() => setEditor(medicine ? "edit" : "new")}>{medicine ? "Edit medicine" : "Add medicine"}</Button>}</header>
    {snapshot.recoveries.filter((entry) => entry.table === "medicines" || entry.table === "doses" || entry.table === "intakes").map((entry) => <p key={`${entry.table}-${entry.id}`} role="alert" className="text-destructive">{entry.reason} ({entry.id})</p>)}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {id && !medicine ? <p>This medicine is no longer available. <Link className="underline" to="/medicines">Back to medicines</Link></p> : null}
    {!id ? <>
      {!snapshot.medicines.length ? <p>Add a medicine you take on a schedule, or one you take only when needed.</p> : null}
      {scheduled.length && asNeeded.length ? <h2 className="pt-2 font-semibold">Scheduled</h2> : null}
      {scheduled.map(row)}
      {asNeeded.length ? <h2 className="pt-4 font-semibold">As needed</h2> : null}
      {asNeeded.map(row)}
      {archivedList.length ? <>
        <Button variant="ghost" className="self-start" aria-expanded={archiveOpen} onClick={() => setArchiveOpen((open) => !open)}>{`Archived (${archivedList.length})`}</Button>
        {archiveOpen ? archivedList.map(row) : null}
      </> : null}
    </> : null}
    {medicine ? <>
      {medicine.instructions ? <p>{medicine.instructions}</p> : null}<p className="text-sm text-muted-foreground">{medicineCadence(medicine)}{medicine.asNeeded ? null : " · "}{medicine.asNeeded ? null : medicine.untilEmpty ? `Until pills run out · last dose ${medicine.endsOn} at ${medicineLastDoseAt(medicine)}` : medicine.endsOn ? `Through ${medicine.endsOn}` : "Ongoing"}</p>
      {archived ? <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3"><h2 className="font-semibold">Archived</h2><Button variant="outline" disabled={busy} onClick={() => void run(() => replica.medicines.unarchive(medicine.id))}>Unarchive</Button></div> : <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3"><span className="tabular-nums">{supplyLabel(medicine) ?? "Pills not counted"}</span><span className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => setCounting("restock")}>Restock</Button><Button variant="outline" disabled={busy} onClick={() => setCounting("count")}>{medicine.supply ? "Recount" : "Count pills"}</Button></span></div>
      {medicine.asNeeded ? <>
        <h2 className="font-semibold">{intakes[0] ? `Taken ${intakeTime(intakes[0].takenAt, today)}` : "Not taken yet"}</h2>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); takeAsNeeded(medicine); }}>
          <label className="flex w-28 flex-col gap-1">Pills<Input type="number" min={1} step={1} aria-label="Pills to take" value={amount} onChange={(event) => setTakeAmount({ id: medicine.id, value: event.target.value })} required /></label>
          <Button type="submit" disabled={busy}>Take</Button>
          {lastIntake?.medicineId === medicine.id ? <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(async () => { await replica.medicines.removeIntake(lastIntake.id); setLastIntake(null); })}>Undo</Button> : null}
        </form>
        <Button variant="outline" disabled={busy} onClick={() => void run(() => replica.medicines.archive(medicine.id))}>Archive medicine</Button>
      </> : <>
      <h2 className="font-semibold">{medicineState(medicine, today) === "active" ? medicineOccurrences(medicine, today).length ? "Today" : (medicineNextDay(medicine, today) ? `Next dose ${medicineDay(medicineNextDay(medicine, today)!, today)}` : "No more doses") : medicineState(medicine, today)}</h2>
      {medicineOccurrences(medicine, today).map((planned) => {
        const dose = snapshot.doses.find((item) => item.id === planned.id) ?? planned;
        return <div key={dose.id} className="flex min-h-12 items-center justify-between gap-3 border-b py-2"><span>{time(dose.scheduledAt)}</span>{dose.takenAt || dose.skippedAt ? <span className="text-sm">{dose.takenAt ? `Taken at ${time(dose.takenAt)}` : "Skipped"} <Button variant="ghost" disabled={busy} onClick={() => void run(() => replica.medicines.undo(dose.id))}>Undo</Button></span> : <Button disabled={busy} onClick={() => take(dose)}>Taken {time(dose.scheduledAt)} dose</Button>}</div>;
      })}
      {undo ? <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await replica.medicines.undo(undo); setUndo(null); })}>Undo last taken dose</Button> : null}
      {medicineState(medicine, today) === "ended" ? <Button variant="outline" disabled={busy} onClick={() => void run(() => replica.medicines.archive(medicine.id))}>Archive medicine</Button>
        : <Button variant="outline" disabled={busy} onClick={() => void run(() => replica.medicines.edit(medicine.id, { ...medicine, paused: !medicine.paused }))}>{medicine.paused ? "Resume reminders" : "Pause reminders"}</Button>}
      </>}
      </>}
      <h2 className="font-semibold">History</h2>
      {medicine.asNeeded ? <>
        {!intakes.length ? <p className="text-sm text-muted-foreground">Each time you take it will appear here.</p> : null}
        {intakes.map((intake) => <div key={intake.id} className="flex min-h-12 items-center justify-between gap-3 border-b py-2"><span>{medicineToday(new Date(intake.takenAt))} · {time(intake.takenAt)} · {pillCount(intake.amount)}</span><Button variant="ghost" disabled={busy} aria-label={`Remove ${time(intake.takenAt)} entry`} onClick={() => void run(() => replica.medicines.removeIntake(intake.id))}>Remove</Button></div>)}
      </> : <><p className="text-sm text-muted-foreground">Taken at records when you pressed Taken.</p>
      {snapshot.doses.filter((dose) => dose.medicineId === medicine.id).sort((a, b) => b.on.localeCompare(a.on)).map((dose) => <div key={dose.id} className="flex flex-col gap-1 border-b py-2"><span>{dose.on} · Scheduled {time(dose.scheduledAt)}</span><span className="text-sm text-muted-foreground">{dose.takenAt ? `Taken at ${time(dose.takenAt)}` : dose.skippedAt ? "Skipped" : "Not recorded"}</span></div>)}</>}
      <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete medicine</Button><Link to="/medicines" className="text-sm underline">Back to medicines</Link>
    </> : null}
    <Sheet open={editor !== null} onClose={() => { setEditor(null); setSearch({}); }} title={editor === "edit" ? "Edit medicine" : "Add medicine"}>
      {editor ? <MedicineForm key={`${editor}-${id ?? "new"}`} replica={replica} source={editor === "edit" ? medicine : undefined} onSaved={(medicineId) => { setEditor(null); void navigate(`/medicines/${medicineId}`); }} /> : null}
    </Sheet>
    {medicine && counting === "restock" ? <PillCountSheet title="How many pills did you get?" initial={medicine.supply?.refill ?? null} onClose={() => setCounting(null)} onSave={(amount) => { setCounting(null); void restockWithUndo({ replica, medicineId: medicine.id, amount, onError: setError }); }} /> : null}
    {medicine && counting === "count" ? <PillCountSheet title="How many pills do you have now?" initial={medicine.supply?.pillsLeft ?? null} min={0} onClose={() => setCounting(null)} onSave={(pillsLeft) => { setCounting(null); void run(() => replica.medicines.setSupply(medicine.id, { pillsLeft, leadDays: medicine.supply?.leadDays ?? DEFAULT_LEAD_DAYS })); }} /> : null}
    <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete medicine?">
      <p>Its dose history will also be removed.</p><div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void run(async () => { await replica.medicines.remove(medicine!.id); setConfirmDelete(false); void navigate('/medicines'); })}>Delete</Button></div>
    </Sheet>
  </main>;
}
