import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router";
import {
  LayoutDashboard,
  FolderGit2,
  KeyRound,
  FileText,
  Settings,
  Plug,
  Plus,
  Terminal,
  Search,
  MessageSquare,
} from "lucide-react";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import { APP_ACTIONS, type AppAction } from "@zero/core";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/lib/settings-store";

// ── Icon map (lucide-react can't live in @zero/core) ─────────────────────

const ACTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  goToDashboard: LayoutDashboard,
  goToProjects: FolderGit2,
  goToSecrets: KeyRound,
  goToTemplates: FileText,
  goToSettings: Settings,
  goToProviders: Plug,
  listSessions: MessageSquare,
  newSession: Plus,
  commandPalette: Terminal,
};

// ── Types ────────────────────────────────────────────────────────────────

interface CommandPaletteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenProjectPicker: () => void;
  onOpenSessionPicker: () => void;
}

export default function CommandPaletteDialog({
  open,
  onOpenChange,
  onOpenProjectPicker,
  onOpenSessionPicker,
}: CommandPaletteDialogProps) {
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const prefix = useSettingsStore((s) => s.settings.hotkeyPrefix);
  const bindings = useSettingsStore((s) => s.settings.hotkeyBindings);

  // ── Action handlers (close palette, then do the thing) ──────────────

  const handlers: Record<string, () => void> = useMemo(
    () => ({
      goToDashboard: () => { onOpenChange(false); void navigate("/"); },
      goToProjects: () => { onOpenChange(false); void navigate("/projects"); },
      goToSecrets: () => { onOpenChange(false); void navigate("/secrets"); },
      goToTemplates: () => { onOpenChange(false); void navigate("/templates"); },
      goToSettings: () => { onOpenChange(false); void navigate("/settings"); },
      goToProviders: () => { onOpenChange(false); void navigate("/settings/providers"); },
      listSessions: () => { onOpenChange(false); onOpenSessionPicker(); },
      newSession: () => { onOpenChange(false); onOpenProjectPicker(); },
      // commandPalette is omitted — it makes no sense to open the palette from itself
    }),
    [navigate, onOpenChange, onOpenProjectPicker, onOpenSessionPicker],
  );

  // ── Build command list from APP_ACTIONS (exclude actions without a handler) ──

  const commands = useMemo(
    () =>
      APP_ACTIONS
        .filter((a) => handlers[a.id] != null)
        .map((a: AppAction) => ({
          ...a,
          icon: ACTION_ICONS[a.id] ?? Terminal,
          action: handlers[a.id],
          hotkey: bindings[a.id], // may be undefined
        })),
    [handlers, bindings],
  );

  const filtered = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase()),
  );

  // Group filtered commands by category (preserve insertion order)
  const grouped = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const cmd of filtered) {
      const list = map.get(cmd.category);
      if (list) {
        list.push(cmd);
      } else {
        map.set(cmd.category, [cmd]);
      }
    }
    return map;
  }, [filtered]);

  // Reset state when dialog opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  // Keep selectedIndex in bounds
  useEffect(() => {
    setSelectedIndex((prev) =>
      filtered.length === 0 ? 0 : Math.min(prev, filtered.length - 1),
    );
  }, [filtered.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-command-item]");
    const item = items[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < filtered.length - 1 ? prev + 1 : prev,
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex].action();
        }
        break;
    }
  };

  // Render the grouped list, tracking a flat index for selection highlighting
  let flatIndex = -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl gap-0 p-0 overflow-hidden"
        showCloseButton={false}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command Palette</DialogTitle>
          <DialogDescription>
            Search for a command to run
          </DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            placeholder="Type a command..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            className="border-0 shadow-none focus-visible:ring-0 h-11"
            autoFocus
          />
        </div>

        {/* Command list */}
        <div ref={listRef} className="max-h-[28rem] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No matching commands
            </div>
          )}

          {[...grouped.entries()].map(([category, cmds]) => (
            <div key={category}>
              <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/60">
                {category}
              </div>
              {cmds.map((cmd) => {
                flatIndex++;
                const idx = flatIndex;
                return (
                  <button
                    key={cmd.id}
                    data-command-item
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                      idx === selectedIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-muted/50",
                    )}
                    onClick={() => cmd.action()}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <cmd.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{cmd.label}</span>
                    {cmd.hotkey && (
                      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                          {formatForDisplay(prefix)}
                        </kbd>
                        <span>→</span>
                        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                          {formatForDisplay(cmd.hotkey)}
                        </kbd>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
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
            run{" "}
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
