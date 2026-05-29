import { useState } from "react";
import { Button } from "@/components/ui/button";

export function DevToolbar({ onResetOnboarding }: { onResetOnboarding: () => void }) {
  const [busy, setBusy] = useState(false);

  if (import.meta.env.PROD) return null;

  return (
    <div className="fixed bottom-4 right-4 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 shadow-sm">
      <span className="text-xs font-medium text-muted-foreground">Dev</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void (async () => {
            await fetch("/api/user-settings", {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ onboardingSeen: false }),
            });
            setBusy(false);
            onResetOnboarding();
          })();
        }}
      >
        {busy ? "Resetting…" : "Reset onboarding"}
      </Button>
    </div>
  );
}
