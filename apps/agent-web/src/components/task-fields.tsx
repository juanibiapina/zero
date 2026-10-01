import { useState } from "react";
import { scheduleLabel, type Project, type Task, type WaitingCondition } from "@zero/agent-core";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarGlyph, ScheduleMenu } from "@/components/schedule-menu";
import { ProjectOptionList } from "@/components/ProjectOptionList";
import { useLocalDay } from "@/lib/local-day";

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

export function TaskProjectField({ projects, tasks, conditions, projectId, onPick, onOpen, compact = false }: {
  projects: Project[];
  tasks: Task[];
  conditions: WaitingCondition[];
  projectId: string | null;
  onPick: (projectId: string | null) => void;
  onOpen?: () => void;
  compact?: boolean;
}) {
  const today = useLocalDay();
  const [open, setOpen] = useState(false);
  const current = projects.find((project) => project.id === projectId);
  return (
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
  );
}
