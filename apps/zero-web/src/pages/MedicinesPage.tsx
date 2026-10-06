import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { MedicineDraft, medicineEndDate, medicineOccurrences, medicineState, medicineToday, type Medicine, type MedicineInput, type TaskdoReplica, type Dose } from "@zero/agent-core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { useTodoData } from "@/lib/todo-data";
import { useLocalDay } from "@/lib/local-day";

const time = (instant: string) => new Date(instant).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function MedicineForm({ replica, source, copy = false, onSaved }: { replica: TaskdoReplica; source?: Medicine; copy?: boolean; onSaved: (id: string) => void }) {
  const [draft, setDraft] = useState<MedicineInput>(() => MedicineDraft.create(medicineToday(), source, copy).input);
  const [endMode, setEndMode] = useState<"ongoing" | "last-day" | "days">(source?.endsOn && !copy ? "last-day" : "ongoing");
  const [days, setDays] = useState("10"); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const end = (() => { try { return endMode === "ongoing" ? null : endMode === "days" ? medicineEndDate(draft.startsOn, Number(days)) : draft.endsOn ?? draft.startsOn; } catch { return null; } })();
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const value = { ...draft, instructions: draft.instructions?.trim() || null, endsOn: endMode === "days" ? medicineEndDate(draft.startsOn, Number(days)) : end };
      if (source && !copy) { await replica.medicines.edit(source.id, value); onSaved(source.id); }
      else { const medicine = await replica.medicines.add(value); onSaved(medicine.id); }
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex flex-col gap-5">
    <fieldset disabled={busy} className="flex flex-col gap-4"><legend className="sr-only">Medicine details</legend>
      <label className="flex flex-col gap-2">Name<Input aria-label="Medicine name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
      <label className="flex flex-col gap-2">Instructions<Input aria-label="Medicine instructions" placeholder="1 pill after food" value={draft.instructions ?? ""} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
      <fieldset className="flex flex-col gap-3"><legend className="mb-2 font-semibold">Daily doses</legend>
        {draft.doses.map((dose, index) => <div key={dose.id} className="flex flex-col gap-2 border-b pb-4">
          <div className="flex items-center justify-between"><span>Dose {index + 1}</span>{draft.doses.length > 1 ? <Button type="button" variant="ghost" onClick={() => setDraft({ ...draft, doses: draft.doses.filter((item) => item.id !== dose.id) })}>Remove dose {index + 1}</Button> : null}</div>
          <div className="flex gap-3"><label className="flex flex-1 flex-col gap-1">Alarm<Input type="time" aria-label={`Alarm ${index + 1}`} value={dose.alarmAt} onChange={(event) => setDraft({ ...draft, doses: draft.doses.map((item) => item.id === dose.id ? { ...item, alarmAt: event.target.value } : item) })} required /></label>
            <label className="flex flex-1 flex-col gap-1">Remind from<Input type="time" aria-label={`Remind from ${index + 1}`} value={dose.remindAt} onChange={(event) => setDraft({ ...draft, doses: draft.doses.map((item) => item.id === dose.id ? { ...item, remindAt: event.target.value } : item) })} required /></label></div>
        </div>)}
        <Button type="button" variant="outline" disabled={draft.doses.length >= 24} onClick={() => setDraft(MedicineDraft.create(medicineToday(), draft).addTime().input)}>Add dose time</Button>
      </fieldset>
      <label className="flex flex-col gap-2">Starts<Input type="date" value={draft.startsOn} onChange={(event) => setDraft({ ...draft, startsOn: event.target.value })} required /></label>
      <fieldset className="flex flex-col gap-2"><legend>Ends</legend><div className="flex flex-wrap gap-3">{(["ongoing", "last-day", "days"] as const).map((mode) => <label key={mode} className="flex min-h-10 items-center gap-2"><input type="radio" name="end-mode" checked={endMode === mode} onChange={() => setEndMode(mode)} />{mode === "ongoing" ? "Ongoing" : mode === "days" ? "Number of days" : "Last day"}</label>)}</div></fieldset>
      {endMode === "days" ? <label className="flex flex-col gap-2">Number of days<Input type="number" min={1} max={36500} step={1} value={days} onChange={(event) => setDays(event.target.value)} required /></label> : null}
      {endMode === "last-day" ? <label className="flex flex-col gap-2">Last day<Input type="date" min={draft.startsOn} value={end ?? draft.startsOn} onChange={(event) => setDraft({ ...draft, endsOn: event.target.value })} required /></label> : null}
      {endMode === "days" && end ? <p className="text-sm text-muted-foreground">Last day: {end}, inclusive</p> : null}
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
  const [editor, setEditor] = useState<"new" | "edit" | "copy" | null>(search.has("new") ? "new" : null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<string | null>(null); const [confirmDelete, setConfirmDelete] = useState(false);
  const run = async (operation: () => Promise<void>) => { setError(null); setBusy(true); try { await operation(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  const take = (dose: Dose) => void run(async () => { await replica!.medicines.take(dose); setUndo(dose.id); });
  if (!replica || !snapshot) return <p className="p-6">Opening medicines…</p>;
  return <main className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6 sm:px-6">
    <header className="flex items-center justify-between gap-3"><h1 className="text-2xl font-semibold">{medicine?.name ?? "Medicines"}</h1><Button variant="outline" onClick={() => setEditor(medicine ? "edit" : "new")}>{medicine ? "Edit medicine" : "Add medicine"}</Button></header>
    {snapshot.recoveries.filter((entry) => entry.table === "medicines" || entry.table === "doses").map((entry) => <p key={`${entry.table}-${entry.id}`} role="alert" className="text-destructive">{entry.reason} ({entry.id})</p>)}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {id && !medicine ? <p>This medicine is no longer available. <Link className="underline" to="/medicines">Back to medicines</Link></p> : null}
    {!id ? <>
      {!snapshot.medicines.length ? <p>Add a medicine with one or more daily dose times.</p> : null}
      {snapshot.medicines.map((item) => {
        const expected = medicineOccurrences(item, today); const taken = expected.filter((dose) => snapshot.doses.some((row) => row.id === dose.id && row.takenAt)).length;
        const state = medicineState(item, today);
        return <Link key={item.id} to={`/medicines/${item.id}`} className="flex min-h-12 flex-col gap-1 border-b py-3"><span className="font-semibold">{item.name}</span><span className="text-sm text-muted-foreground">{item.doses.map((dose) => dose.alarmAt).join(" · ")} · {state === "active" ? `${taken} of ${expected.length} taken` : state}</span></Link>;
      })}
    </> : null}
    {medicine ? <>
      {medicine.instructions ? <p>{medicine.instructions}</p> : null}<p className="text-sm text-muted-foreground">Daily · {medicine.doses.length} {medicine.doses.length === 1 ? "time" : "times"} · {medicine.endsOn ? `Through ${medicine.endsOn}` : "Ongoing"}</p>
      <h2 className="font-semibold">{medicineState(medicine, today) === "active" ? "Today" : medicineState(medicine, today)}</h2>
      {medicineOccurrences(medicine, today).map((planned) => {
        const dose = snapshot.doses.find((item) => item.id === planned.id) ?? planned;
        return <div key={dose.id} className="flex min-h-12 items-center justify-between gap-3 border-b py-2"><span>{time(dose.scheduledAt)}</span>{dose.takenAt ? <span className="text-sm">Taken at {time(dose.takenAt)} <Button variant="ghost" disabled={busy} onClick={() => void run(() => replica.medicines.undo(dose.id))}>Undo</Button></span> : <Button disabled={busy} onClick={() => take(dose)}>Taken {time(dose.scheduledAt)} dose</Button>}</div>;
      })}
      {undo ? <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await replica.medicines.undo(undo); setUndo(null); })}>Undo last taken dose</Button> : null}
      {medicineState(medicine, today) === "ended" ? <Button variant="outline" onClick={() => setEditor("copy")}>Add again</Button> : <Button variant="outline" disabled={busy} onClick={() => void run(() => replica.medicines.edit(medicine.id, { ...medicine, paused: !medicine.paused }))}>{medicine.paused ? "Resume reminders" : "Pause reminders"}</Button>}
      <h2 className="font-semibold">History</h2><p className="text-sm text-muted-foreground">Taken at records when you pressed Taken.</p>
      {snapshot.doses.filter((dose) => dose.medicineId === medicine.id).sort((a, b) => b.on.localeCompare(a.on)).map((dose) => <div key={dose.id} className="flex flex-col gap-1 border-b py-2"><span>{dose.on} · Scheduled {time(dose.scheduledAt)}</span><span className="text-sm text-muted-foreground">{dose.takenAt ? `Taken at ${time(dose.takenAt)}` : "Not recorded"}</span></div>)}
      <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete medicine</Button><Link to="/medicines" className="text-sm underline">Back to medicines</Link>
    </> : null}
    <Sheet open={editor !== null} onClose={() => { setEditor(null); setSearch({}); }} title={editor === "edit" ? "Edit medicine" : "Add medicine"}>
      {editor ? <MedicineForm key={`${editor}-${id ?? "new"}`} replica={replica} source={editor === "edit" || editor === "copy" ? medicine : undefined} copy={editor === "copy"} onSaved={(medicineId) => { setEditor(null); void navigate(`/medicines/${medicineId}`); }} /> : null}
    </Sheet>
    <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete medicine?">
      <p>Its dose history will also be removed.</p><div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void run(async () => { await replica.medicines.remove(medicine!.id); setConfirmDelete(false); void navigate('/medicines'); })}>Delete</Button></div>
    </Sheet>
  </main>;
}
