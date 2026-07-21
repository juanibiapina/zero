import { useState, useEffect, useCallback } from "react";
import { useAuth, useOrganization } from "@clerk/clerk-react";
import { Plus, Trash2, Copy, Check } from "lucide-react";
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@zero/ui";
import * as api from "@/lib/api";
import type { ApiKeyInfo } from "@zero/vault-core";

export default function KeysPage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const load = useCallback(async () => {
    const { keys } = await api.listApiKeys(tokenFn);
    setKeys(keys);
    setLoading(false);
  }, [tokenFn, organization?.id]);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await api.createApiKey(tokenFn, newLabel.trim() || undefined);
    setNewKey(result.key);
    setNewLabel("");
    void load();
  };

  const handleCopy = async () => {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = async (id: number) => {
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    await api.revokeApiKey(tokenFn, id);
    void load();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">API Keys</h1>

      <form onSubmit={(e) => void handleCreate(e)} className="flex gap-2 max-w-md">
        <Input
          placeholder="Label (optional)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <Button type="submit" size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Create
        </Button>
      </form>

      {newKey && (
        <div className="rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950">
          <p className="text-sm font-medium mb-2">
            New API key created. Copy it now — it won't be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm font-mono bg-background px-3 py-2 rounded border break-all">
              {newKey}
            </code>
            <Button size="sm" variant="outline" onClick={() => void handleCopy()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setNewKey(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : keys.length === 0 ? (
        <p className="text-muted-foreground">No API keys yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-24">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell className="font-mono">
                  {k.prefix}{k.suffix}
                </TableCell>
                <TableCell>{k.label || "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(k.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleRevoke(k.id)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
