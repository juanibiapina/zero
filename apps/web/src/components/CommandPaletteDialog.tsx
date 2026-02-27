import { useMemo, useCallback } from "react";
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
  MessageSquare,
  Trash2,
  ArrowLeftRight,
  Cpu,
} from "lucide-react";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import { APP_ACTIONS, type AppAction } from "@zero/core";
import PickerDialog from "@/components/PickerDialog";
import { useSettingsStore } from "@/lib/settings-store";
import { useActionHandlerStore } from "@/lib/action-handlers";

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
  deleteCurrentSession: Trash2,
  switchProvider: ArrowLeftRight,
  switchModel: Cpu,
};

// ── Types ────────────────────────────────────────────────────────────────

interface Command extends AppAction {
  icon: React.ComponentType<{ className?: string }>;
  action: () => void;
  hotkey?: string;
}

interface CommandPaletteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenProjectPicker: () => void;
  onOpenSessionPicker: () => void;
}

const filterCommand = (cmd: Command, query: string) =>
  cmd.label.toLowerCase().includes(query.toLowerCase());

const commandKey = (cmd: Command) => cmd.id;
const commandGroup = (cmd: Command) => cmd.category;

export default function CommandPaletteDialog({
  open,
  onOpenChange,
  onOpenProjectPicker,
  onOpenSessionPicker,
}: CommandPaletteDialogProps) {
  const navigate = useNavigate();
  const prefix = useSettingsStore((s) => s.settings.hotkeyPrefix);
  const bindings = useSettingsStore((s) => s.settings.hotkeyBindings);
  const registeredHandlers = useActionHandlerStore((s) => s.handlers);

  // ── Action handlers (close palette, then do the thing) ──────────────

  const handlers: Record<string, () => void> = useMemo(
    () => {
      const base: Record<string, () => void> = {
        goToDashboard: () => { onOpenChange(false); void navigate("/"); },
        goToProjects: () => { onOpenChange(false); void navigate("/projects"); },
        goToSecrets: () => { onOpenChange(false); void navigate("/secrets"); },
        goToTemplates: () => { onOpenChange(false); void navigate("/templates"); },
        goToSettings: () => { onOpenChange(false); void navigate("/settings"); },
        goToProviders: () => { onOpenChange(false); void navigate("/settings/providers"); },
        listSessions: () => { onOpenChange(false); onOpenSessionPicker(); },
        newSession: () => { onOpenChange(false); onOpenProjectPicker(); },
      };
      // Merge in page-level registered handlers (e.g. switchProvider, switchModel)
      for (const [id, handler] of Object.entries(registeredHandlers)) {
        base[id] = () => { onOpenChange(false); handler(); };
      }
      return base;
    },
    [navigate, onOpenChange, onOpenProjectPicker, onOpenSessionPicker, registeredHandlers],
  );

  // ── Build command list from APP_ACTIONS ─────────────────────────────

  const commands: Command[] = useMemo(
    () =>
      APP_ACTIONS
        .filter((a) => handlers[a.id] != null)
        .map((a) => ({
          ...a,
          icon: ACTION_ICONS[a.id] ?? Terminal,
          action: handlers[a.id],
          hotkey: bindings[a.id],
        })),
    [handlers, bindings],
  );

  const handleSelect = useCallback((cmd: Command) => {
    cmd.action();
  }, []);

  const renderItem = useCallback(
    (cmd: Command) => (
      <>
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
      </>
    ),
    [prefix],
  );

  return (
    <PickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command Palette"
      description="Search for a command to run"
      placeholder="Type a command..."
      items={commands}
      filterFn={filterCommand}
      renderItem={renderItem}
      onSelect={handleSelect}
      keyFn={commandKey}
      groupBy={commandGroup}
      enterVerb="run"
      emptyMessage="No matching commands"
    />
  );
}
