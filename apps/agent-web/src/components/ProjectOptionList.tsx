import { useMemo, useState } from "react";
import {
  PROJECT_DISPLAY_STATUS_LABELS,
  projectStatusSections,
  type Project,
  type ProjectDisplayStatus,
  type Task,
  type WaitingCondition,
} from "@zero/agent-core";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function ProjectOptionList({
  projects,
  tasks,
  conditions,
  today,
  afterSourceProjectId,
  selectedProjectId,
  showNoProject = false,
  emptyCopy,
  onPick,
}: {
  projects: Project[];
  tasks: Task[];
  conditions: WaitingCondition[];
  today: string;
  afterSourceProjectId?: string;
  selectedProjectId?: string | null;
  showNoProject?: boolean;
  emptyCopy?: string;
  onPick: (projectId: string | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const [collapseOverride, setCollapseOverride] = useState<Partial<Record<ProjectDisplayStatus, boolean>>>({});
  const sections = useMemo(() => projectStatusSections({
    projects, tasks, conditions, today, filter, collapseOverride, afterSourceProjectId,
  }), [projects, tasks, conditions, today, filter, collapseOverride, afterSourceProjectId]);
  const searching = filter.trim().length > 0;

  return (
    <>
      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        autoFocus={afterSourceProjectId != null}
        autoComplete="off"
        aria-label={afterSourceProjectId == null ? "Filter projects" : "Filter After projects"}
        placeholder="Filter projects"
        className="mb-2 h-11"
      />
      {showNoProject && (
        <button
          type="button"
          aria-label="No project"
          aria-current={selectedProjectId == null ? "true" : undefined}
          className="flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-muted-foreground hover:bg-muted/60"
          onClick={() => onPick(null)}
        >
          <span aria-hidden className="w-5 text-center">⊘</span>
          No project
        </button>
      )}
      <div className="max-h-72 overflow-y-auto">
        {sections.length === 0 && (searching || emptyCopy) && (
          <p className="px-3 py-3 text-sm text-muted-foreground">
            {searching ? "No matching projects" : emptyCopy}
          </p>
        )}
        {sections.map((section) => (
          <section key={section.status}>
            <button
              type="button"
              aria-label={`${PROJECT_DISPLAY_STATUS_LABELS[section.status]}, ${section.count}`}
              aria-expanded={!section.collapsed}
              disabled={searching}
              className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm font-semibold text-muted-foreground hover:bg-muted/60 disabled:hover:bg-transparent"
              onClick={() => setCollapseOverride((prev) => ({ ...prev, [section.status]: !section.collapsed }))}
            >
              <span aria-hidden>{section.collapsed ? "▸" : "▾"}</span>
              {PROJECT_DISPLAY_STATUS_LABELS[section.status]}
              <span className="opacity-70">· {section.count}</span>
            </button>
            {!section.collapsed && section.projects.map((project) => (
              <button
                key={project.id}
                type="button"
                aria-current={project.id === selectedProjectId ? "true" : undefined}
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-muted/60",
                  project.id === selectedProjectId && "font-medium text-primary",
                )}
                onClick={() => onPick(project.id)}
              >
                <span aria-hidden className="w-5 text-center text-base leading-none">{project.icon}</span>
                <span className="min-w-0 flex-1 truncate">{project.title}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
