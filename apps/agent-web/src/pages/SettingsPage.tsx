import { useCallback, useEffect, useState } from "react";
import { useClerk, useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AppHeader } from "@/components/AppHeader";
import { ConnectedStatus, ErrorText } from "@/components/ConnectionStatus";
import {
  GOOGLE_WORKSPACE_SCOPES,
  missingScopes,
} from "../google-scopes";
import {
  TelegramLoginWidget,
  type TelegramAuthPayload,
} from "@/components/TelegramLoginWidget";

// Clerk's createExternalAccount/reauthorize want a mutable string[].
const GOOGLE_SCOPES_MUTABLE: string[] = [...GOOGLE_WORKSPACE_SCOPES];

const TELEGRAM_BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string;
// The ?start= payload makes Telegram show a Start button instead of the input
// bar, which is how Zero gets to speak first on a new chat.
const TELEGRAM_DEEP_LINK = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=welcome`;

// ─── Helpers ────────────────────────────────────────────────────────

function StatusText({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

// ─── Telegram ───────────────────────────────────────────────────────

function TelegramConnect() {
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/telegram-id");
      if (!res.ok) {
        if (!cancelled) {
          setError(`Failed to load: ${res.status}`);
          setLoaded(true);
        }
        return;
      }
      const data = (await res.json()) as { telegramId: string | null };
      if (!cancelled) {
        setTelegramId(data.telegramId);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onAuth = useCallback(
    (payload: TelegramAuthPayload) => {
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          const res = await fetch("/api/telegram-link", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            setError(`Link failed: ${res.status}`);
            return;
          }
          const data = (await res.json()) as { telegramId: string | null };
          setTelegramId(data.telegramId);
        } finally {
          setBusy(false);
        }
      })();
    },
    [],
  );

  const onDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/telegram-id", {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(`Disconnect failed: ${res.status}`);
        return;
      }
      setTelegramId(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram</CardTitle>
        <CardDescription>
          Link your Telegram account to talk to the bot.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!loaded ? (
          <StatusText>Loading…</StatusText>
        ) : telegramId === null ? (
          <TelegramLoginWidget onAuth={onAuth} />
        ) : (
          <>
            <ConnectedStatus>Connected · {telegramId}</ConnectedStatus>
            <div className="flex items-center gap-3">
              <a
                href={TELEGRAM_DEEP_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-foreground underline underline-offset-4 hover:text-foreground/70"
              >
                Open in Telegram
              </a>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void onDisconnect();
                }}
              >
                Disconnect
              </Button>
            </div>
          </>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </CardContent>
    </Card>
  );
}

// ─── Google ─────────────────────────────────────────────────────────

function GoogleConnect() {
  const { isLoaded, user } = useUser();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isLoaded || !user) return null;

  const google = user.externalAccounts.find((a) => a.provider === "google");
  const missing = google
    ? missingScopes(google.approvedScopes, GOOGLE_WORKSPACE_SCOPES)
    : [];

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Navigate to Clerk's consent URL to complete the OAuth flow.
  const redirectTo = (url: URL | null | undefined) => {
    if (url) window.location.href = url.toString();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Workspace</CardTitle>
        <CardDescription>
          Grant access to Gmail, Calendar, Drive, and Sheets.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!google ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await user.createExternalAccount({
                  strategy: "oauth_google",
                  additionalScopes: GOOGLE_SCOPES_MUTABLE,
                  redirectUrl: window.location.origin,
                });
                redirectTo(result.verification?.externalVerificationRedirectURL);
              })
            }
          >
            {busy ? "Connecting…" : "Connect Google"}
          </Button>
        ) : missing.length > 0 ? (
          <>
            <StatusText>
              Connected as {google.emailAddress}, but missing required scopes.
            </StatusText>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const updated = await google.reauthorize({
                    additionalScopes: GOOGLE_SCOPES_MUTABLE,
                    redirectUrl: window.location.origin,
                  });
                  redirectTo(updated.verification?.externalVerificationRedirectURL);
                })
              }
            >
              {busy ? "Opening…" : "Grant missing scopes"}
            </Button>
          </>
        ) : (
          <>
            <ConnectedStatus>Connected · {google.emailAddress}</ConnectedStatus>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await google.destroy();
                  await user.reload();
                })
              }
            >
              Disconnect
            </Button>
            <RerunOnboarding />
          </>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </CardContent>
    </Card>
  );
}

// ─── Re-run onboarding ──────────────────────────────────────────────

// Re-run the one-shot Gmail onboarding scan (force=true bypasses the
// once-per-user guard). The scan runs in the background on the DO alarm and
// rebuilds the pinned "User" topic; there is no live progress to show
// here, so we just confirm the request was queued.
function RerunOnboarding() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rerun = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch("/api/onboarding/google?force=true", {
        method: "POST",
      });
      if (!res.ok) {
        setError(`Failed: ${res.status}`);
        return;
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <StatusText>
        Re-scan your Gmail to rebuild what the assistant knows about you.
      </StatusText>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void rerun()}
      >
        {busy ? "Queuing…" : done ? "Queued ✓" : "Re-run onboarding"}
      </Button>
      {done && (
        <StatusText>
          Queued. It runs in the background; give it a minute.
        </StatusText>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

// ─── Delete my data ─────────────────────────────────────────────────

// Erase everything Zero holds for this user. The request is synchronous on the
// server (a 200 means the data is already gone), and on success we sign the
// user out: their settings, topics and files no longer exist, so there is
// nothing left for a signed-in session to show, and signing in again starts
// them fresh.
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
          Deleted: your conversations and messages, everything the assistant
          learned about you, your uploaded files, your schedules and reminders,
          your Telegram link, and your settings.
        </StatusText>
        <StatusText>
          Kept: your sign-in account, and your Google and Telegram accounts
          (disconnect those above if you want them gone too). Your Telegram chat
          history stays on your own device, and usage logs age out on their own.
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
      <AppHeader />

      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <TelegramConnect />
          <GoogleConnect />
          <DangerZone />
        </div>
      </main>
    </div>
  );
}
