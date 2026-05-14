import { useEffect, useState } from "react";
import { ClerkProvider, SignIn, UserButton, useAuth } from "@clerk/clerk-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

  return <TelegramIdForm />;
}

export default function App() {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY!}>
      <AuthGate />
    </ClerkProvider>
  );
}
