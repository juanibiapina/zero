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

export type ProjectSuggestionState = { selection: ProjectSelection; loading: boolean };

// Holds the Project a new Task will be filed under while the user types. It asks
// for a suggestion after a pause in typing, drops answers for older text, and
// never overrides a Project the user or the screen chose. A suggestion made for
// older text is dropped as soon as the text changes, and `loading` is true
// whenever a suggestion can still arrive, so the screen shows exactly what an
// add would save.
export class ProjectSuggester {
  private state: ProjectSuggestionState;
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
    this.state = { selection: options.initial ?? NO_SELECTION, loading: false };
    this.delayMs = options.delayMs ?? 400;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): ProjectSuggestionState => this.state;

  update(input: { title: string; candidates: ProjectSuggestionCandidate[]; enabled: boolean }): void {
    const title = input.title.trim();
    const candidatesKey = JSON.stringify(input.candidates);
    if (title === this.title && candidatesKey === this.candidatesKey && input.enabled === this.enabled) return;
    const titleChanged = title !== this.title;
    this.title = title;
    this.candidates = input.candidates;
    this.candidatesKey = candidatesKey;
    this.enabled = input.enabled;
    this.cancel();
    let selection = this.state.selection;
    if (selection.source === "context" || selection.source === "manual") {
      this.set(selection, false);
      return;
    }
    if (!this.enabled || title.length < MIN_TITLE || this.candidates.length === 0) {
      this.set(NO_SELECTION, false);
      return;
    }
    if (
      selection.source === "suggested" &&
      (titleChanged || !this.candidates.some((project) => project.id === selection.projectId))
    ) {
      selection = NO_SELECTION;
    }
    this.timer = setTimeout(() => void this.ask(title), this.delayMs);
    this.set(selection, true);
  }

  pick(projectId: string | null): void {
    this.cancel();
    this.set({ projectId, source: "manual" }, false);
  }

  reset(initial: ProjectSelection = NO_SELECTION): void {
    this.cancel();
    this.title = "";
    this.candidatesKey = "";
    this.set(initial, false);
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
    this.set(known ? { projectId, source: "suggested" } : NO_SELECTION, false);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private set(selection: ProjectSelection, loading: boolean): void {
    const current = this.state;
    if (
      selection.projectId === current.selection.projectId &&
      selection.source === current.selection.source &&
      loading === current.loading
    ) {
      return;
    }
    this.state = { selection, loading };
    for (const listener of this.listeners) listener();
  }
}
