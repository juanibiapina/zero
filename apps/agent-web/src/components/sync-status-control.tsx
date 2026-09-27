import { todoSyncPresentation, type TodoSyncDisplayKind } from "@zero/agent-core";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTodoData } from "@/lib/todo-data";

function StatusGlyph({ kind, className }: { kind: TodoSyncDisplayKind; className?: string }) {
  if (kind === "busy") return (
    <svg viewBox="0 0 24 24" fill="none" className={`${className ?? ""} animate-spin`} aria-hidden>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {kind === "synced" ? <><path d="M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.26 8.5 4.5 4.5 0 0 0 7 18Z" /><path d="m9 13 2 2 4-4" /></>
        : kind === "offline" ? <><path d="m3 3 18 18" /><path d="M10.6 5.13A6 6 0 0 1 17.7 10a4 4 0 0 1 2.06 6.5" /><path d="M6.26 8.5A4.5 4.5 0 0 0 7 18h8" /></>
          : kind === "warning" ? <><path d="M10.3 3.4 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.4a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>
            : <><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M10 18h4" /></>}
    </svg>
  );
}

function formatRelative(value: string, now = new Date()): string {
  const date = new Date(value);
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1_000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SyncStatusControl() {
  const data = useTodoData();
  const status = todoSyncPresentation({ signedIn: true, durable: data.durable, sync: data.sync });
  const lastSync = data.sync.lastSyncedAt ? new Date(data.sync.lastSyncedAt) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={status.label}
          className="grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <StatusGlyph kind={status.kind} className="size-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
        <div className="flex items-start gap-3 border-b p-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground">
            <StatusGlyph kind={status.kind} className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold">{status.label}</p>
            <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{status.description}</p>
          </div>
        </div>
        <dl className="space-y-3 p-4 text-sm">
          <div className="flex items-start justify-between gap-6">
            <dt className="text-muted-foreground">Last synced</dt>
            <dd className="text-right font-medium">
              {lastSync ? (
                <><span className="block">{formatRelative(data.sync.lastSyncedAt!)}</span><span className="block text-xs font-normal text-muted-foreground">{lastSync.toLocaleString()}</span></>
              ) : "Not yet"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-6">
            <dt className="text-muted-foreground">Offline copy</dt>
            <dd className="font-medium">{data.durable ? "Available" : "Unavailable"}</dd>
          </div>
        </dl>
        {data.durabilityError ? <p className="border-t px-4 py-3 text-sm text-destructive">{data.durabilityError}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
