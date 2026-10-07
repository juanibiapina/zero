import { useState, type ComponentProps, type ReactNode } from "react";
import { scheduleLabel, type Project, type Task, type TaskDraftView, type WaitingCondition } from "@zero/agent-core";
import type { TextRange } from "@zeroapps/recurrence";
import { ScheduleHighlightInput } from "@/components/ScheduleHighlightInput";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { CalendarGlyph, ScheduleMenu } from "@/components/schedule-menu";
import { ProjectOptionList } from "@/components/ProjectOptionList";
import { useLocalDay } from "@/lib/local-day";

export function TaskFields({ draft, onChangeText, onDismissRange, inputProps, leading, trailing, dateField, projectField, compact = false, children }: {
  draft: TaskDraftView;
  onChangeText: (text: string) => void;
  onDismissRange: (range: TextRange) => void;
  inputProps: Omit<ComponentProps<typeof ScheduleHighlightInput>, "value" | "ranges" | "onChange" | "onDismissRange">;
  leading?: ReactNode;
  trailing?: ReactNode;
  dateField?: Omit<ComponentProps<typeof TaskDateField>, "date" | "label" | "compact">;
  projectField?: Omit<ComponentProps<typeof TaskProjectField>, "compact">;
  compact?: boolean;
  children?: ReactNode;
}) {
  const ranges = dateField ? draft.ranges : [];
  return <>
    <div className={compact ? "flex items-center gap-2" : "flex items-center gap-3"}>
      {leading}
      <ScheduleHighlightInput {...inputProps} value={draft.text} ranges={ranges}
        onChange={(event) => onChangeText(event.target.value)} onDismissRange={onDismissRange} />
      {trailing}
    </div>
    {dateField || projectField ? <div className="flex flex-wrap gap-2">
      {!compact && ranges[0] ? <Button type="button" variant="ghost" onClick={() => onDismissRange(ranges[0])}>Keep schedule words in task title</Button> : null}
      {dateField ? <TaskDateField {...dateField} compact={compact} date={draft.date} label={draft.date != null || draft.recurrence ? draft.label : undefined} /> : null}
      {projectField ? <TaskProjectField {...projectField} compact={compact} /> : null}
      {children}
    </div> : null}
  </>;
}

export function TaskDateField({ date, label, onPick, onOpen, onStopRecurrence, onCompleteForever, compact = false }: {
  date: string | null;
  label?: string;
  onPick: (date: string | null) => void;
  onOpen?: () => void;
  onStopRecurrence?: () => void;
  onCompleteForever?: () => void;
  compact?: boolean;
}) {
  const today = useLocalDay();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={(next) => { if (next) onOpen?.(); setOpen(next); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size={compact ? "sm" : "default"} aria-label={compact ? date ? `Date: ${date}` : "Add a date" : undefined}>
          <CalendarGlyph className="size-4" />
          {label ?? (compact && !date ? "No date" : scheduleLabel(date, today))}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <ScheduleMenu today={today} selected={date} onPick={(next) => { onPick(next); setOpen(false); }} />
        {onStopRecurrence ? <Button type="button" variant="ghost" className="w-full" onClick={() => { onStopRecurrence(); setOpen(false); }}>Stop repeating</Button> : null}
        {onCompleteForever ? <Button type="button" variant="ghost" className="w-full" onClick={() => { onCompleteForever(); setOpen(false); }}>Complete forever</Button> : null}
      </PopoverContent>
    </Popover>
  );
}

export function TaskProjectField({ projects, tasks, conditions, projectId, loading = false, onClear, onPick, onOpen, compact = false }: {
  projects: Project[];
  tasks: Task[];
  conditions: WaitingCondition[];
  projectId: string | null;
  loading?: boolean;
  onClear?: () => void;
  onPick: (projectId: string | null) => void;
  onOpen?: () => void;
  compact?: boolean;
}) {
  const today = useLocalDay();
  const [open, setOpen] = useState(false);
  const current = projects.find((project) => project.id === projectId);
  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={(next) => { if (next) onOpen?.(); setOpen(next); }}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size={compact ? "sm" : "default"} aria-label={compact ? current ? `Project: ${current.title}` : "Add to a project" : undefined}>
            {current ? <span aria-hidden>{current.icon}</span> : null}
            {current?.title ?? (compact ? "No project" : "Project")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-1">
          <ProjectOptionList projects={projects} tasks={tasks} conditions={conditions} today={today} selectedProjectId={projectId} showNoProject onPick={(id) => { onPick(id); setOpen(false); }} />
        </PopoverContent>
      </Popover>
      {current && onClear ? <Button type="button" variant="ghost" size="icon" aria-label="Clear project" className={compact ? "size-8" : undefined} onClick={onClear}>
        <span aria-hidden className="text-lg leading-none">×</span>
      </Button> : null}
      {loading ? <span role="status" aria-label="Suggesting a project" className="text-muted-foreground"><Spinner className="size-4" /></span> : null}
    </div>
  );
}
