import { DEFAULT_ICON } from "./display";

export type IconSuggestionRequest = (
  input: { title: string; description: null },
  signal: AbortSignal,
) => Promise<string[]>;

export type IconChoiceSource = "default" | "suggested" | "manual";

export type IconChoice = {
  icon: string;
  source: IconChoiceSource;
  icons: string[];
  status: "idle" | "loading" | "ready" | "error";
};

const MIN_TITLE = 3;
const INITIAL: IconChoice = { icon: DEFAULT_ICON, source: "default", icons: [], status: "idle" };

export class IconSuggester {
  private current: IconChoice = INITIAL;
  private title = "";
  private enabled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly request: IconSuggestionRequest;
  private readonly delayMs: number;

  constructor(options: { request: IconSuggestionRequest; delayMs?: number }) {
    this.request = options.request;
    this.delayMs = options.delayMs ?? 400;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getChoice = (): IconChoice => this.current;

  update(input: { title: string; enabled: boolean }): void {
    const title = input.title.trim();
    if (title === this.title && input.enabled === this.enabled) return;
    this.title = title;
    this.enabled = input.enabled;
    this.cancel();
    if (!this.enabled || title.length < MIN_TITLE) {
      this.set(this.current.source === "manual"
        ? { ...this.current, icons: [], status: "idle" }
        : INITIAL);
      return;
    }
    this.set({ ...this.current, status: "loading" });
    this.timer = setTimeout(() => void this.ask(title), this.delayMs);
  }

  pick(icon: string): void {
    this.set({ ...this.current, icon, source: "manual" });
  }

  reset(): void {
    this.cancel();
    this.title = "";
    this.set(INITIAL);
  }

  dispose(): void {
    this.cancel();
    this.title = "";
  }

  private async ask(title: string): Promise<void> {
    this.timer = null;
    const controller = new AbortController();
    this.inFlight = controller;
    let icons: string[] | null;
    try {
      icons = await this.request({ title, description: null }, controller.signal);
    } catch {
      icons = null;
    }
    if (controller.signal.aborted || title !== this.title) return;
    this.inFlight = null;
    const status = icons == null ? "error" : "ready";
    const next = icons ?? [];
    if (this.current.source === "manual") {
      this.set({ ...this.current, icons: next, status });
    } else if (next[0]) {
      this.set({ icon: next[0], source: "suggested", icons: next, status });
    } else {
      this.set({ icon: DEFAULT_ICON, source: "default", icons: next, status });
    }
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private set(next: IconChoice): void {
    const now = this.current;
    if (next.icon === now.icon && next.source === now.source && next.status === now.status
      && next.icons.length === now.icons.length && next.icons.every((icon, i) => icon === now.icons[i])) return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}
