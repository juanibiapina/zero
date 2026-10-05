import { useState, useEffect, useCallback } from "react";
import { Link, useParams } from "react-router";
import { useAuth, useOrganization } from "@clerk/react";
import { Plus, Trash2, Eye, EyeOff, Save, ArrowLeft } from "lucide-react";
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useAsyncData,
  AsyncState,
} from "@zero/ui";
import * as api from "@/products/vault/lib/api";
import type { SecretEntry } from "@zero/vault-core";

export default function SecretsPage() {
  const { project, env } = useParams<{ project: string; env: string }>();
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [dirty, setDirty] = useState(false);

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const state = useAsyncData(
    () =>
      project && env
        ? api.getSecrets(tokenFn, project, env)
        : Promise.resolve({ secrets: [] }),
    [tokenFn, project, env, organization?.id],
  );

  // Seed the editable local state from each successful fetch. Save stays local
  // (no reload), so this is the only place fetched secrets enter the form.
  useEffect(() => {
    if (state.data) {
      setSecrets(
        [...state.data.secrets].sort((a, b) => a.key.localeCompare(b.key)),
      );
      setDirty(false);
    }
  }, [state.data]);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    setSecrets((prev) => [
      ...prev.filter((s) => s.key !== newKey.trim()),
      { key: newKey.trim(), value: newValue },
    ].sort((a, b) => a.key.localeCompare(b.key)));
    setNewKey("");
    setNewValue("");
    setDirty(true);
  };

  const handleDelete = (key: string) => {
    setSecrets((prev) => prev.filter((s) => s.key !== key));
    setDirty(true);
  };

  const handleValueChange = (key: string, value: string) => {
    setSecrets((prev) =>
      prev.map((s) => (s.key === key ? { ...s, value } : s))
    );
    setDirty(true);
  };

  const handleSave = async () => {
    if (!project || !env) return;
    await api.putSecrets(tokenFn, project, env, secrets);
    setDirty(false);
  };

  const toggleReveal = (key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/vault/projects/${project}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">
          {project} / {env}
        </h1>
        {dirty && (
          <Button size="sm" onClick={() => void handleSave()}>
            <Save className="h-4 w-4 mr-1" />
            Save
          </Button>
        )}
      </div>

      <form onSubmit={handleAdd} className="flex gap-2 max-w-2xl">
        <Input
          placeholder="KEY"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          className="font-mono"
        />
        <Input
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          className="font-mono"
        />
        <Button type="submit" size="sm">
          <Plus className="h-4 w-4" />
        </Button>
      </form>

      <AsyncState state={state} onRetry={state.reload}>
        {() =>
          secrets.length === 0 ? (
            <p className="text-muted-foreground">No secrets yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {secrets.map((s) => (
                  <TableRow key={s.key}>
                    <TableCell className="font-mono font-medium">{s.key}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {revealed.has(s.key) ? (
                          <Input
                            value={s.value}
                            onChange={(e) => handleValueChange(s.key, e.target.value)}
                            className="font-mono h-8"
                          />
                        ) : (
                          <span className="font-mono text-muted-foreground">••••••••</span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleReveal(s.key)}
                        >
                          {revealed.has(s.key) ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(s.key)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </AsyncState>
    </div>
  );
}
