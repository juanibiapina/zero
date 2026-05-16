import { useEffect, useState } from "react";
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

if (!PUBLISHABLE_KEY) {
  throw new Error("Add your Clerk Publishable Key to .env.local");
}

function TelegramIdForm() {
  const { getToken } = useAuth();
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      const res = await fetch("/api/telegram-id", {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!res.ok) {
        if (!cancelled) {
          setStatus(`Failed to load: ${res.status}`);
          setLoaded(true);
        }
        return;
      }
      const data = (await res.json()) as { telegramId: string | null };
      if (!cancelled) {
        setValue(data.telegramId ?? "");
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  const onSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const trimmed = value.trim();
      const token = await getToken();
      const res = await fetch("/api/telegram-id", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? ""}`,
        },
        body: JSON.stringify({ telegramId: trimmed === "" ? null : trimmed }),
      });
      if (!res.ok) {
        setStatus(`Save failed: ${res.status}`);
        return;
      }
      setStatus("Saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Zero</h1>
        <UserButton />
      </div>

      <div className="space-y-2">
        <label htmlFor="telegram-id" className="text-sm font-medium">
          Telegram user ID
        </label>
        <Input
          id="telegram-id"
          placeholder="123456789"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!loaded || saving}
        />
      </div>

      <Button onClick={() => { void onSave(); }} disabled={!loaded || saving}>
        {saving ? "Saving…" : "Save"}
      </Button>

      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}

function AuthGate() {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <SignIn />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TelegramIdForm />
      <GoogleConnect />
    </div>
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
    <div className="mx-auto w-full max-w-md space-y-3 px-6">
      <h2 className="text-sm font-medium">Google Workspace</h2>
      {!google ? (
        <>
          <p className="text-sm text-muted-foreground">
            Grant the bot access to your Gmail, Calendar, Drive, and Sheets.
          </p>
          <Button
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
            {busy ? "Opening…" : "Connect Google"}
          </Button>
        </>
      ) : missing.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground">
            Connected as {google.emailAddress}, but missing required scopes.
          </p>
          <Button
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
            {busy ? "Opening…" : "Grant required scopes"}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Connected ✅ {google.emailAddress}
          </p>
          <Button
            variant="link"
            className="h-auto p-0 text-sm"
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
      {error && <p className="text-sm text-destructive">{error}</p>}
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
