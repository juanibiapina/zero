import { useCallback } from "react";
import { useNavigate } from "react-router";
import { MessageSquare } from "lucide-react";
import PickerDialog from "@/components/PickerDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { useSessionStore, type SessionEntry } from "@/lib/session-store";

interface SessionPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const filterSession = (s: SessionEntry, query: string) => {
  const q = query.toLowerCase();
  return (
    s.title.toLowerCase().includes(q) ||
    `${s.owner}/${s.repo}`.toLowerCase().includes(q)
  );
};

const sessionKey = (s: SessionEntry) => s.id;

const SessionItem = ({ session }: { session: SessionEntry }) => (
  <>
    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 truncate font-medium">
      {session.title}
    </span>
    <span className="shrink-0 text-xs text-muted-foreground">
      {session.owner}/{session.repo}
    </span>
    <StatusBadge status={session.status} />
  </>
);

export default function SessionPickerDialog({
  open,
  onOpenChange,
}: SessionPickerDialogProps) {
  const navigate = useNavigate();
  const sessions = useSessionStore((s) => s.sessions);

  const handleSelect = useCallback(
    (session: SessionEntry) => {
      onOpenChange(false);
      void navigate(
        `/p/${session.owner}/${session.repo}/sessions/${session.id}`,
      );
    },
    [navigate, onOpenChange],
  );

  const renderItem = useCallback(
    (session: SessionEntry) => <SessionItem session={session} />,
    [],
  );

  return (
    <PickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sessions"
      description="Select a session to open"
      placeholder="Search sessions..."
      items={sessions}
      filterFn={filterSession}
      renderItem={renderItem}
      onSelect={handleSelect}
      keyFn={sessionKey}
      enterVerb="open session"
      emptyMessage="No matching sessions"
      noItemsMessage="No sessions yet"
    />
  );
}
