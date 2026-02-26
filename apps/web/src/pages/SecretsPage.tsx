import { useEffect, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import { KeyRound, Trash2, Plus, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SecretEntry } from "@zero/core";
import { jsonBody } from "@/lib/api";

export default function SecretsPage() {
  const { getToken } = useAuth();
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchSecrets = async () => {
    try {
      const token = await getToken();
      const resp = await fetch("/api/secrets", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await jsonBody<{ secrets?: SecretEntry[] }>(resp);
      setSecrets(data.secrets ?? []);
    } catch (err) {
      console.error("Failed to fetch secrets:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchSecrets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addSecret = async () => {
    if (!newName.trim() || !newValue.trim()) return;
    setSaving(true);
    try {
      const token = await getToken();
      const resp = await fetch("/api/secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: newName.trim(), value: newValue.trim() }),
      });
      const data = await jsonBody<{ success?: boolean }>(resp);
      if (data.success) {
        setNewName("");
        setNewValue("");
        await fetchSecrets();
      }
    } catch (err) {
      console.error("Failed to add secret:", err);
    } finally {
      setSaving(false);
    }
  };

  const deleteSecret = async (name: string) => {
    try {
      const token = await getToken();
      await fetch(`/api/secrets/${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchSecrets();
    } catch (err) {
      console.error("Failed to delete secret:", err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void addSecret();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading secrets...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          <h1 className="text-2xl font-bold">Secrets</h1>
        </div>
        <p className="text-muted-foreground mt-1">
          Named environment variables injected into every agent session.
          Values are write-only — they cannot be read back.
        </p>
      </div>

      <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Secrets are visible to agents as environment variables. Any tool or
          shell command the agent runs can read them. Only add secrets you are
          comfortable sharing with the agent.
        </span>
      </div>

      {/* Existing secrets */}
      {secrets.length > 0 && (
        <div className="rounded-lg border divide-y">
          {secrets.map((secret) => (
            <div
              key={secret.name}
              className="flex items-center justify-between px-4 py-3"
            >
              <div>
                <span className="font-mono text-sm font-medium">
                  {secret.name}
                </span>
                <span className="ml-3 text-xs text-muted-foreground">
                  added{" "}
                  {new Date(secret.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void deleteSecret(secret.name)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {secrets.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No secrets yet. Add one below.
        </p>
      )}

      {/* Add new secret */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          placeholder="Name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={handleKeyDown}
          className="font-mono"
        />
        <Input
          type="password"
          placeholder="Value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Button
          onClick={() => void addSecret()}
          disabled={saving || !newName.trim() || !newValue.trim()}
          className="shrink-0"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add
        </Button>
      </div>
    </div>
  );
}
