import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { isNull, type Transaction } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { toast, type TaskdoReplica } from "@zero/agent-core";
import { parseSchedule, toText, type TextRange } from "@zeroapps/recurrence";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ScheduleHighlightInput } from "@/components/ScheduleHighlightInput";
import { ProjectOptionList } from "@/components/ProjectOptionList";
import { TaskDateField, TaskProjectField } from "@/components/task-fields";
import { reportTodoError } from "@/lib/todo-feedback";
import { useLocalDay } from "@/lib/local-day";
import { useTodoData } from "@/lib/todo-data";
import { requestIconSuggestions } from "@/lib/icon-suggestions";

export type TodoAddKind = "task" | "project" | "waiting" | "after";
const LABELS: Record<TodoAddKind, string> = { task: "Task", project: "Project", waiting: "Waiting condition", after: "After project" };

export function TodoComposer({ replica, projectId: contextProjectId = null, initialKind = "task", onCreated, onDraftChange }: {
  replica: TaskdoReplica;
  projectId?: string | null;
  initialKind?: TodoAddKind;
  onCreated?: () => void;
  onDraftChange?: (hasDraft: boolean) => void;
}) {
  const { authenticatedFeatures = true, saveLocal } = useTodoData();
  const navigate = useNavigate();
  const today = useLocalDay();
  const [kind, setKind] = useState(initialKind);
  const [text, setText] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(contextProjectId);
  const [ignored, setIgnored] = useState<TextRange[]>([]);
  const [pending, setPending] = useState(false);
  const [retryAddition, setRetryAddition] = useState<(() => Promise<void>) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const saveErrorToast = useRef<string | null>(null);
  const { data: projects = [] } = useLiveQuery((q) => q.from({ p: replica.projects.collection }));
  const { data: tasks = [] } = useLiveQuery((q) => q.from({ t: replica.tasks.collection }).where(({ t }) => isNull(t.completedAt)));
  const { data: conditions = [] } = useLiveQuery((q) => q.from({ w: replica.waits.collection }));
  const parsed = useMemo(() => kind === "task" ? parseSchedule(text, { today, weekStartsOn: "MO", ignored }) : { kind: "none" as const }, [kind, text, today, ignored]);
  const schedule = parsed.kind === "scheduled" ? parsed.schedule : null;
  const recurrence = schedule?.kind === "recurring" ? schedule.recurrence : null;
  const effectiveDate = schedule?.kind === "once" ? schedule.date : recurrence?.origin ?? date;
  const effectiveText = parsed.kind === "scheduled" ? parsed.remainingText : text.trim();
  const context = projects.find((project) => project.id === contextProjectId);
  const kinds: TodoAddKind[] = contextProjectId ? ["task", "waiting", "after", "project"] : ["task", "project"];
  const placeholder = kind === "project" ? "Name an outcome" : kind === "waiting" ? "What are you waiting for?" : "Add a task";
  const reset = () => {
    setText(""); setDate(null); setProjectId(contextProjectId); setIgnored([]); onDraftChange?.(false);
  };

  const finish = () => {
    if (saveErrorToast.current) toast.dismiss(saveErrorToast.current);
    saveErrorToast.current = null;
    reset(); setRetryAddition(null); onCreated?.(); input.current?.focus();
  };
  const persist = async (tx: Transaction, onSaved = () => {}) => {
    try { await tx.isPersisted.promise; }
    catch (error) {
      const id = String(tx.mutations[0]?.key);
      const snapshot = replica.snapshot();
      if ([...snapshot.tasks, ...snapshot.projects, ...snapshot.conditions].some((row) => row.id === id)) {
        onDraftChange?.(true);
        setRetryAddition(() => async () => {
          if (!saveLocal) throw new Error("Local save retry is unavailable.");
          await saveLocal(); onSaved(); finish();
        });
      }
      throw error;
    }
    onSaved();
  };
  const add = async (afterId?: string) => {
    if (pending) return;
    const title = (kind === "task" ? effectiveText : text).trim();
    if (!retryAddition && kind !== "after" && !title) return;
    setPending(true);
    try {
      if (retryAddition) { await retryAddition(); return; }
      if (kind === "after") {
        if (!contextProjectId || !afterId) return;
        await persist(replica.waits.addAfter(contextProjectId, afterId));
      } else if (kind === "waiting") {
        if (!contextProjectId) return;
        await persist(replica.waits.addWaiting(contextProjectId, title));
      } else if (kind === "project") {
        const tx = replica.projects.add(title);
        const id = String(tx.mutations[0]?.key);
        await persist(tx, () => {
          if (authenticatedFeatures) void requestIconSuggestions(id, { title, description: null });
          if (initialKind === "project" && !contextProjectId) void navigate(`/projects/${id}`);
          else toast("Project created", { description: title, action: { label: "View", onPress: () => void navigate(`/projects/${id}`) } });
        });
      } else {
        await persist(replica.tasks.add(title, effectiveDate, projectId, recurrence), () => {
          if (projectId && projectId !== contextProjectId) {
            const project = projects.find((item) => item.id === projectId);
            const future = effectiveDate != null && effectiveDate > today;
            toast("Filed to project", { description: future ? "Upcoming" : project ? `${project.icon} ${project.title}` : undefined,
              action: { label: "View", onPress: () => void navigate(future ? "/upcoming" : `/projects/${projectId}`) } });
          }
        });
      }
      finish();
    } catch (error) {
      if (saveErrorToast.current) toast.dismiss(saveErrorToast.current);
      saveErrorToast.current = reportTodoError(error);
    } finally { setPending(false); }
  };

  return <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void add(); }}>
    <fieldset disabled={pending || retryAddition !== null} className="flex flex-col gap-3">
      <legend className="sr-only">What to add</legend>
      <div role="radiogroup" aria-label="What to add" className="flex flex-wrap gap-2">
        {kinds.map((value) => <label key={value} className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm focus-within:ring-2 focus-within:ring-ring">
          <input type="radio" name="add-kind" checked={kind === value} onChange={() => setKind(value)} />{LABELS[value]}
        </label>)}
      </div>
      {(kind === "waiting" || kind === "after") && context ? <p className="text-sm text-muted-foreground">For {context.icon} {context.title}</p> : null}
      {kind === "after" ? <ProjectOptionList projects={projects} tasks={tasks} conditions={conditions} today={today} afterSourceProjectId={contextProjectId ?? undefined} emptyCopy="No available projects" onPick={(id) => { if (id) void add(id); }} /> : <>
        <div className="flex items-center gap-2">
          <ScheduleHighlightInput ref={input} autoFocus value={text} ranges={parsed.kind === "scheduled" ? parsed.consumed : []} placeholder={placeholder} aria-label={placeholder}
            onChange={(event) => { setText(event.target.value); setIgnored([]); onDraftChange?.(event.target.value.trim() !== ""); }}
            onDismissRange={(range) => setIgnored((current) => [...current, range])} />
          <Button type="submit" disabled={pending || !effectiveText.trim()}>{pending ? "Saving…" : "Add"}</Button>
        </div>
        {kind === "task" ? <div className="flex flex-wrap gap-2">
          <TaskDateField compact date={effectiveDate} label={recurrence ? toText(recurrence) : undefined} onPick={(next) => {
            if (parsed.kind === "scheduled") { setText(effectiveText); setIgnored(effectiveText ? [{ start: 0, end: effectiveText.length, text: effectiveText }] : []); }
            setDate(next);
          }} />
          <TaskProjectField compact projects={projects} tasks={tasks} conditions={conditions} projectId={projectId} onPick={setProjectId} />
        </div> : null}
      </>}
    </fieldset>
    {retryAddition ? <div className="flex flex-col gap-2"><p role="alert" className="text-sm text-destructive">Your addition is still in memory. Save it again before continuing.</p><Button type="submit" disabled={pending}>{pending ? "Saving…" : "Try saving again"}</Button></div> : null}
  </form>;
}

export function useTodoAdd({ replica, projectId, initialKind = "project" }: { replica: TaskdoReplica; projectId?: string; initialKind?: TodoAddKind }) {
  const [kind, setKind] = useState<TodoAddKind | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const close = () => { if (hasDraft) setConfirmDiscard(true); else setKind(null); };
  const discard = () => { setKind(null); setHasDraft(false); setConfirmDiscard(false); };
  return {
    open: (value: TodoAddKind = initialKind) => setKind(value),
    composer: <>
      <Sheet open={kind != null} onClose={close} title={kind ? `Add ${LABELS[kind].toLowerCase()}` : "Add"}>
        {kind ? <TodoComposer key={`${projectId}-${kind}`} replica={replica} projectId={projectId} initialKind={kind} onDraftChange={setHasDraft} onCreated={discard} /> : null}
        <div className="mt-4 flex justify-end"><Button variant="ghost" onClick={close}>Cancel</Button></div>
      </Sheet>
      <Sheet open={confirmDiscard} onClose={() => setConfirmDiscard(false)} title="Discard draft?">
        <p>Your draft will be cleared.</p>
        <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmDiscard(false)}>Keep editing</Button><Button variant="destructive" onClick={discard}>Discard</Button></div>
      </Sheet>
    </>,
  };
}
