import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/clerk-react";
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

// ─── Google ─────────────────────────────────────────────────────────

function GoogleCard() {
  const { user } = useUser();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const google = user.externalAccounts.find((a) => a.provider === "google");
  const missing = google
    ? missingScopes(google.approvedScopes, GOOGLE_WORKSPACE_SCOPES)
    : [];
  const connected = !!google && missing.length === 0;

  // Navigate to Clerk's consent URL to complete the OAuth flow.
  const redirectTo = (url: URL | null | undefined) => {
    if (url) window.location.href = url.toString();
  };

  const connect = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        if (google && missing.length > 0) {
          const updated = await google.reauthorize({
            additionalScopes: GOOGLE_SCOPES_MUTABLE,
            redirectUrl: window.location.origin,
          });
          redirectTo(updated.verification?.externalVerificationRedirectURL);
        } else {
          const result = await user.createExternalAccount({
            strategy: "oauth_google",
            additionalScopes: GOOGLE_SCOPES_MUTABLE,
            redirectUrl: window.location.origin,
          });
          redirectTo(result.verification?.externalVerificationRedirectURL);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    })();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Workspace</CardTitle>
        <CardDescription>
          Access to Gmail, Calendar, Drive, and Sheets.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connected ? (
          <ConnectedStatus>Connected · {google.emailAddress}</ConnectedStatus>
        ) : (
          <Button disabled={busy} onClick={connect}>
            {busy ? "Connecting…" : google ? "Grant access" : "Connect Google"}
          </Button>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </CardContent>
    </Card>
  );
}

// ─── Telegram ───────────────────────────────────────────────────────

function TelegramCard({
  telegramId,
  onLinked,
}: {
  telegramId: string | null;
  onLinked: (id: string | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const onAuth = useCallback(
    (payload: TelegramAuthPayload) => {
      void (async () => {
        setError(null);
        try {
          const res = await fetch("/api/telegram-link", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            setError(`Link failed: ${res.status}`);
            return;
          }
          const data = (await res.json()) as { telegramId: string | null };
          onLinked(data.telegramId);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    },
    [onLinked],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram</CardTitle>
        <CardDescription>
          Link your account to chat with the bot.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {telegramId === null ? (
          <TelegramLoginWidget onAuth={onAuth} />
        ) : (
          <div className="animate-in fade-in duration-200 motion-reduce:animate-none">
            <ConnectedStatus>Connected · {telegramId}</ConnectedStatus>
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </CardContent>
    </Card>
  );
}

// ─── Completion ─────────────────────────────────────────────────────

function CompletionBlock({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">You're all set.</p>
        <p className="text-sm text-muted-foreground">
          Open Telegram and send a message to start your first conversation.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <a
          href={`https://t.me/${TELEGRAM_BOT_USERNAME}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onFinish}
        >
          <Button>Open in Telegram</Button>
        </a>
        <Button variant="ghost" onClick={onFinish}>
          Go to settings
        </Button>
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="container mx-auto px-4 py-10 sm:px-6 sm:py-14 lg:py-16">
        <div className="mx-auto w-full max-w-md space-y-8">{children}</div>
      </main>
    </div>
  );
}

export function Onboarding({
  onComplete,
  googleOnboardingStatus,
}: {
  onComplete: () => void;
  googleOnboardingStatus: string | null;
}) {
  const { isLoaded, user } = useUser();
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [telegramLoaded, setTelegramLoaded] = useState(false);

  // Fetch telegram link state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/telegram-id");
      if (!res.ok) {
        if (!cancelled) setTelegramLoaded(true);
        return;
      }
      const data = (await res.json()) as { telegramId: string | null };
      if (!cancelled) {
        setTelegramId(data.telegramId);
        setTelegramLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const google = user?.externalAccounts.find((a) => a.provider === "google");
  const googleConnected = google
    ? missingScopes(google.approvedScopes, GOOGLE_WORKSPACE_SCOPES).length === 0
    : false;
  const telegramConnected = telegramId !== null;
  const bothConnected = googleConnected && telegramConnected;

  // Fire the onboarding task once, when Google connects and it hasn't started.
  useEffect(() => {
    if (!googleConnected || googleOnboardingStatus) return;
    void fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Onboard this new user using your google-onboarding skill.",
        name: "google-onboarding",
      }),
    });
  }, [googleConnected, googleOnboardingStatus]);

  // Mark onboarding seen once both connections are complete.
  const completedRef = useRef(false);
  const markSeen = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    void fetch("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingSeen: true }),
    });
  }, []);

  useEffect(() => {
    if (bothConnected) markSeen();
  }, [bothConnected, markSeen]);

  const finish = useCallback(() => {
    markSeen();
    onComplete();
  }, [markSeen, onComplete]);

  if (!isLoaded || !telegramLoaded) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Welcome to Zero
        </h1>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Connect your accounts to start chatting with your assistant in
          Telegram.
        </p>
      </div>

      <div className="space-y-4">
        <GoogleCard />
        <TelegramCard telegramId={telegramId} onLinked={setTelegramId} />
      </div>

      {bothConnected ? (
        <CompletionBlock onFinish={finish} />
      ) : (
        <div className="flex justify-center">
          <button
            className="text-sm text-muted-foreground/70 transition-colors hover:text-foreground"
            onClick={finish}
          >
            I'll do this later
          </button>
        </div>
      )}

      <p className="text-center text-xs text-muted-foreground/60">
        You can change these connections anytime in settings.
      </p>
    </Shell>
  );
}
