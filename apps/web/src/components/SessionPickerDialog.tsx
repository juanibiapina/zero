import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { MessageSquare, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/StatusBadge";
import { useSessionStore } from "@/lib/session-store";

interface SessionPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SessionPickerDialog({
  open,
  onOpenChange,
}: SessionPickerDialogProps) {
  const navigate = useNavigate();

  const sessions = useSessionStore((s) => s.sessions);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter sessions by query (match title or owner/repo)
  const filtered = sessions.filter((s) => {
    const q = query.toLowerCase();
    return (
      s.title.toLowerCase().includes(q) ||
      `${s.owner}/${s.repo}`.toLowerCase().includes(q)
    );
  });

  // Clamp selected index to filtered list bounds
  const clampedIndex =
    filtered.length === 0 ? 0 : Math.min(selectedIndex, filtered.length - 1);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[clampedIndex] as
      | HTMLElement
      | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex]);

  const selectSession = (session: (typeof sessions)[number]) => {
    onOpenChange(false);
    void navigate(
      `/p/${session.owner}/${session.repo}/sessions/${session.id}`
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < filtered.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[clampedIndex]) {
          selectSession(filtered[clampedIndex]);
        }
        break;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl gap-0 p-0 overflow-hidden"
        showCloseButton={false}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Sessions</DialogTitle>
          <DialogDescription>
            Select a session to open
          </DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            placeholder="Search sessions..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            className="border-0 shadow-none focus-visible:ring-0 h-11"
            autoFocus
          />
        </div>

        {/* Session list */}
        <div ref={listRef} className="max-h-[28rem] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {sessions.length === 0
                ? "No sessions yet"
                : "No matching sessions"}
            </div>
          )}

          {filtered.map((session, index) => (
            <button
              key={session.id}
              className={cn(
                "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                index === clampedIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-muted/50"
              )}
              onClick={() => selectSession(session)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {session.title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {session.owner}/{session.repo}
              </span>
              <StatusBadge status={session.status} />
            </button>
          ))}
        </div>

        {/* Footer hint */}
        {filtered.length > 0 && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              ↑↓
            </kbd>{" "}
            navigate{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              ↵
            </kbd>{" "}
            open session{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              esc
            </kbd>{" "}
            close
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
