import { cn } from "@zero/ui";
import type { ErrorLevel, IssueStatus } from "@zero/errors-core";

const base =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize";

const levelStyles: Record<ErrorLevel, string> = {
  error: "bg-destructive/10 text-destructive",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  info: "bg-muted text-muted-foreground",
};

const statusStyles: Record<IssueStatus, string> = {
  open: "bg-primary/10 text-primary",
  resolved: "bg-muted text-muted-foreground",
};

export function LevelBadge({ level }: { level: ErrorLevel }) {
  return <span className={cn(base, levelStyles[level])}>{level}</span>;
}

export function StatusBadge({ status }: { status: IssueStatus }) {
  return <span className={cn(base, statusStyles[status])}>{status}</span>;
}
