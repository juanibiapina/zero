import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
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
                href={`https://t.me/${TELEGRAM_BOT_USERNAME}`}
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
          </>
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
        </div>
      </main>
    </div>
  );
}
