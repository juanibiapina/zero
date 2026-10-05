import type { Project, Task } from "../taskdo/types";

export type ProjectSuggestionCandidate = {
  id: string;
  title: string;
  icon: string;
  description: string | null;
  tasks: string[];
};

export type ProjectSuggestionRequest = (
  input: { title: string; projects: ProjectSuggestionCandidate[] },
  signal: AbortSignal,
) => Promise<string | null>;

export type ProjectSelectionSource = "context" | "manual" | "suggested" | "none";

export type ProjectSelection = { projectId: string | null; source: ProjectSelectionSource };

const MAX_PROJECTS = 254;
const MAX_TASKS = 5;
const MIN_TITLE = 3;
const NO_SELECTION: ProjectSelection = { projectId: null, source: "none" };

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
const newestFirst = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);

export const projectSuggestionCandidates = (
  projects: readonly Project[],
  openTasks: readonly Task[],
): ProjectSuggestionCandidate[] => {
  const tasksByProject = new Map<string, Task[]>();
  for (const task of openTasks) {
    if (task.projectId == null || task.completedAt != null) continue;
    tasksByProject.set(task.projectId, [...(tasksByProject.get(task.projectId) ?? []), task]);
  }
  return projects
    .filter((project) => project.state !== "done")
    .sort(newestFirst)
    .slice(0, MAX_PROJECTS)
    .map((project) => ({
      id: project.id,
      title: clip(project.title, 200),
      icon: project.icon,
      description: project.description ? clip(project.description, 300) : null,
      tasks: (tasksByProject.get(project.id) ?? [])
        .sort(newestFirst)
        .slice(0, MAX_TASKS)
        .map((task) => clip(task.text, 200)),
    }));
};

// Holds the Project a new Task will be filed under while the user types. It asks
// for a suggestion after a pause in typing, drops answers for older text, and
// never overrides a Project the user or the screen chose.
export class ProjectSuggester {
  private current: ProjectSelection;
  private title = "";
  private candidates: ProjectSuggestionCandidate[] = [];
  private candidatesKey = "";
  private enabled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly request: ProjectSuggestionRequest;
  private readonly delayMs: number;

  constructor(options: { request: ProjectSuggestionRequest; initial?: ProjectSelection; delayMs?: number }) {
    this.request = options.request;
    this.current = options.initial ?? NO_SELECTION;
    this.delayMs = options.delayMs ?? 400;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSelection = (): ProjectSelection => this.current;

  update(input: { title: string; candidates: ProjectSuggestionCandidate[]; enabled: boolean }): void {
    const title = input.title.trim();
    const candidatesKey = JSON.stringify(input.candidates);
    if (title === this.title && candidatesKey === this.candidatesKey && input.enabled === this.enabled) return;
    this.title = title;
    this.candidates = input.candidates;
    this.candidatesKey = candidatesKey;
    this.enabled = input.enabled;
    this.cancel();
    if (this.current.source === "context" || this.current.source === "manual") return;
    if (this.current.source === "suggested" && !this.candidates.some((project) => project.id === this.current.projectId)) {
      this.set(NO_SELECTION);
    }
    if (!this.enabled || title.length < MIN_TITLE || this.candidates.length === 0) {
      this.set(NO_SELECTION);
      return;
    }
    this.timer = setTimeout(() => void this.ask(title), this.delayMs);
  }

  pick(projectId: string | null): void {
    this.cancel();
    this.set({ projectId, source: "manual" });
  }

  reset(initial: ProjectSelection = NO_SELECTION): void {
    this.cancel();
    this.title = "";
    this.candidatesKey = "";
    this.set(initial);
  }

  dispose(): void {
    this.cancel();
    this.title = "";
    this.candidatesKey = "";
  }

  private async ask(title: string): Promise<void> {
    this.timer = null;
    const controller = new AbortController();
    this.inFlight = controller;
    let projectId: string | null;
    try {
      projectId = await this.request({ title, projects: this.candidates }, controller.signal);
    } catch {
      projectId = null;
    }
    if (controller.signal.aborted || title !== this.title) return;
    this.inFlight = null;
    const known = projectId != null && this.candidates.some((project) => project.id === projectId);
    this.set(known ? { projectId, source: "suggested" } : NO_SELECTION);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private set(next: ProjectSelection): void {
    if (next.projectId === this.current.projectId && next.source === this.current.source) return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}
