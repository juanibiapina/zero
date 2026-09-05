import { Button } from "@/components/ui/button";
import { stopRefine, useRefineSession } from "@/lib/refine-session";

// The refine session banner: pinned while a capture is being refined into tasks
// and projects. Done consumes the capture; Cancel leaves it. Shown on Today and
// Projects (the session is shared), so a refine can span both. `onFinish`
// processes the capture (each page passes its own captures data layer).
export function RefineBanner({
  onFinish,
}: {
  onFinish: (captureId: string) => void;
}) {
  const session = useRefineSession();
  if (!session) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3">
      <span className="flex-1 text-sm">
        🔧 Refining: <b>{session.text}</b> — create tasks and projects; they link
        back to this capture.
      </span>
      <Button size="sm" onClick={() => onFinish(session.id)}>
        Done
      </Button>
      <Button size="sm" variant="ghost" onClick={() => stopRefine()}>
        Cancel
      </Button>
    </div>
  );
}
