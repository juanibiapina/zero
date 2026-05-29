import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClerkProvider,
  SignIn,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/clerk-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  GOOGLE_WORKSPACE_SCOPES,
  missingScopes,
} from "./google-scopes";

// Clerk's createExternalAccount/reauthorize want a mutable string[].
const GOOGLE_SCOPES_MUTABLE: string[] = [...GOOGLE_WORKSPACE_SCOPES];

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const TELEGRAM_BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string | undefined;

if (!PUBLISHABLE_KEY) {
  throw new Error("Add your Clerk Publishable Key to .env.local");
}
if (!TELEGRAM_BOT_USERNAME) {
  throw new Error("Add VITE_TELEGRAM_BOT_USERNAME to .env.local");
}

interface TelegramAuthPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramAuthPayload) => void;
  }
}

// Renders the official Telegram Login Widget script tag. The widget
// injects an iframe and invokes window.onTelegramAuth on success.
function TelegramLoginWidget({
  onAuth,
}: {
  onAuth: (payload: TelegramAuthPayload) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.onTelegramAuth = onAuth;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", TELEGRAM_BOT_USERNAME!);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    containerRef.current?.appendChild(script);
    return () => {
      delete window.onTelegramAuth;
      script.remove();
    };
  }, [onAuth]);

  return <div ref={containerRef} />;
}

function SectionDivider() {
  return <div className="border-t border-border" />;
}

function StatusText({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-destructive">{children}</p>;
}

function TelegramConnect() {
  const { getToken } = useAuth();
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      const res = await fetch("/api/telegram-id", {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
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
  }, [getToken]);

  const onAuth = useCallback(
    (payload: TelegramAuthPayload) => {
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          const token = await getToken();
          const res = await fetch("/api/telegram-link", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token ?? ""}`,
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
    [getToken],
  );

  const onDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/telegram-id", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token ?? ""}` },
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
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Telegram</h2>
      {!loaded ? (
        <StatusText>Loading…</StatusText>
      ) : telegramId === null ? (
        <>
          <StatusText>
            Link your Telegram account to talk to the bot.
          </StatusText>
          <TelegramLoginWidget onAuth={onAuth} />
        </>
      ) : (
        <>
          <StatusText>Connected · {telegramId}</StatusText>
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
    </section>
  );
}

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
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Google Workspace</h2>
      {!google ? (
        <>
          <StatusText>
            Grant access to Gmail, Calendar, Drive, and Sheets.
          </StatusText>
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
        </>
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
          <StatusText>Connected · {google.emailAddress}</StatusText>
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
    </section>
  );
}

interface MountConfigResponse {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
}

function S3MountConfigConnect() {
  const { getToken } = useAuth();
  const [config, setConfig] = useState<MountConfigResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [validateOk, setValidateOk] = useState<boolean | null>(null);

  // Form fields
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      const res = await fetch("/api/mount-config/notes", {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!res.ok) {
        if (!cancelled) {
          setError(`Failed to load: ${res.status}`);
          setLoaded(true);
        }
        return;
      }
      const data = (await res.json()) as MountConfigResponse | null;
      if (!cancelled) {
        setConfig(data);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  const onSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/mount-config/notes", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? ""}`,
        },
        body: JSON.stringify({
          endpoint,
          bucket,
          prefix,
          accessKeyId,
          secretAccessKey,
        }),
      });
      if (res.status === 422) {
        const body = (await res.json()) as { error: string };
        setError(`Validation failed: ${body.error}`);
        return;
      }
      if (!res.ok) {
        setError(`Save failed: ${res.status}`);
        return;
      }
      const data = (await res.json()) as MountConfigResponse;
      setConfig(data);
      setShowForm(false);
    } finally {
      setBusy(false);
    }
  };

  const onValidate = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/mount-config/notes/validate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!res.ok) {
        setError(`Validate request failed: ${res.status}`);
        return;
      }
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (body.ok) {
        setError(null);
        setValidateOk(true);
      } else {
        setValidateOk(false);
        setError(`Validation failed: ${body.error ?? "unknown error"}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/mount-config/notes", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!res.ok) {
        setError(`Disconnect failed: ${res.status}`);
        return;
      }
      setConfig(null);
      setValidateOk(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Notes Storage</h2>
      {!loaded ? (
        <StatusText>Loading…</StatusText>
      ) : config ? (
        <>
          <StatusText>
            {validateOk === false ? "Connection failed" : "Connected"} · {config.endpoint}/{config.bucket}
          </StatusText>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                void onValidate();
              }}
            >
              {busy ? "Checking…" : "Validate connection"}
            </Button>
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
      ) : showForm ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <Input
              placeholder="Endpoint (https://s3.example.com)"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <Input
              placeholder="Bucket"
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
            />
            <Input
              placeholder="Prefix (optional)"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
            <Input
              placeholder="Access Key ID"
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
            />
            <Input
              type="password"
              placeholder="Secret Access Key"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void onSave();
              }}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <StatusText>
            Using default storage. You can configure an external S3-compatible store.
          </StatusText>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowForm(true)}
          >
            Configure external storage
          </Button>
        </>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}

function AuthGate() {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <SignIn />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md px-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-base font-semibold">Zero</h1>
        <UserButton />
      </header>

      <div className="mt-10 space-y-8">
        <TelegramConnect />
        <SectionDivider />
        <GoogleConnect />
        <SectionDivider />
        <S3MountConfigConnect />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY!}>
      <AuthGate />
    </ClerkProvider>
  );
}
