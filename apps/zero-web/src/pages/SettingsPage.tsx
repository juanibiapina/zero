import { useState } from "react";
import { useClerk } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorText } from "@/components/ConnectionStatus";

function StatusText({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

// ─── Delete my data ─────────────────────────────────────────────────

// Erase everything Zero holds for this user. The request is synchronous on the
// server (a 200 means the data is already gone), and on success we sign the
// user out: their tasks and settings no longer exist, so there is nothing left
// for a signed-in session to show, and signing in again starts them fresh.
//
// The typed confirmation is the whole safety mechanism — this is irreversible
// and there is no undo, no export and no grace period.
const CONFIRM_WORD = "DELETE";

function DangerZone() {
  const { signOut } = useClerk();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    setConfirming(false);
    setTyped("");
    setError(null);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/user-data", { method: "DELETE" });
      if (!res.ok) {
        setError(`Delete failed: ${res.status}. Nothing was deleted; try again.`);
        return;
      }
      await signOut({ redirectUrl: "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>Delete my data</CardTitle>
        <CardDescription>
          Erase everything Zero knows about you. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <StatusText>
          Deleted: your tasks, projects, medicines, night routine, and
          settings.
        </StatusText>
        <StatusText>
          Kept: your sign-in account. Usage logs age out on their own.
        </StatusText>
        <StatusText>
          This signs you out. Signing in again gives you a fresh, empty Zero.
        </StatusText>
        {!confirming ? (
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Delete my data
          </Button>
        ) : (
          <div className="space-y-3 border-t pt-3">
            <StatusText>
              Type {CONFIRM_WORD} to confirm.
            </StatusText>
            <Input
              value={typed}
              autoFocus
              aria-label={`Type ${CONFIRM_WORD} to confirm`}
              onChange={(e) => {
                setTyped(e.target.value);
              }}
            />
            <div className="flex items-center gap-3">
              <Button
                variant="destructive"
                size="sm"
                disabled={busy || typed !== CONFIRM_WORD}
                onClick={() => {
                  void remove();
                }}
              >
                {busy ? "Deleting…" : "Delete everything"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </CardContent>
    </Card>
  );
}

// ─── Page ───────────────────────────────────────────────────────────

export function SettingsPage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <DangerZone />
        </div>
      </main>
    </div>
  );
}
