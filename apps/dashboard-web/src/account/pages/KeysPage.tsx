import { useState, useCallback, useEffect, useRef } from "react";
import { useAuth, useOrganization } from "@clerk/react";
import { Plus, Trash2, Copy, Check } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useAsyncData,
  AsyncState,
  toast,
} from "@zero/ui";
import type { ApiKeyInfo } from "@zero/vault-core";
import * as api from "@/account/lib/api";

const loadingSecretsUrl = "https://docs.zeroapps.dev/vault/loading-secrets/";
const sendingErrorsUrl = "https://docs.zeroapps.dev/errors/getting-started/";

const linkClass =
  "font-medium text-foreground underline underline-offset-2 hover:text-primary";

/**
 * The one place a key is created, copied, and revoked. Keys are
 * organization-scoped and authorize every Zero product, so nothing here names
 * a single product as their owner.
 */
export default function KeysPage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const copyRef = useRef<HTMLButtonElement>(null);

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const state = useAsyncData(
    () => api.listApiKeys(tokenFn),
    [tokenFn, organization?.id],
  );
  const { reload } = state;

  // The key is shown once, so land the keyboard user on the copy button.
  useEffect(() => {
    if (newKey) copyRef.current?.focus();
  }, [newKey]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await api.createApiKey(tokenFn, newLabel.trim() || undefined);
    setNewKey(result.key);
    setNewLabel("");
    reload();
  };

  const handleCopy = async () => {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    await api.revokeApiKey(tokenFn, revoking.id);
    reload();
    toast.success("API key revoked");
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">API keys</h1>
        <p className="text-muted-foreground">
          Keys belong to your organization. One key authorizes both Vault and Errors.
        </p>
      </div>

      <form onSubmit={(e) => void handleCreate(e)} className="flex gap-2 max-w-md">
        <Label htmlFor="key-label" className="sr-only">
          Key label
        </Label>
        <Input
          id="key-label"
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
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950"
        >
          <p className="text-sm font-medium mb-2">
            New API key created. Copy it now. It is not shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm font-mono bg-background px-3 py-2 rounded border break-all">
              {newKey}
            </code>
            <Button
              ref={copyRef}
              size="sm"
              variant="outline"
              aria-label="Copy API key"
              onClick={() => void handleCopy()}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Use it with the CLI to{" "}
            <a href={loadingSecretsUrl} target="_blank" rel="noreferrer" className={linkClass}>
              load secrets
            </a>
            , or to{" "}
            <a href={sendingErrorsUrl} target="_blank" rel="noreferrer" className={linkClass}>
              send error reports
            </a>
            .
          </p>
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

      <AsyncState state={state} onRetry={reload}>
        {({ keys }) =>
          keys.length === 0 ? (
            <p className="text-muted-foreground">
              No API keys yet. A key authorizes the <code>zv</code> CLI, your apps, and
              error reporting. See{" "}
              <a href={loadingSecretsUrl} target="_blank" rel="noreferrer" className={linkClass}>
                loading secrets
              </a>{" "}
              or{" "}
              <a href={sendingErrorsUrl} target="_blank" rel="noreferrer" className={linkClass}>
                sending errors
              </a>
              .
            </p>
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
                    <TableCell>{k.label || "None"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Revoke key ${k.prefix}${k.suffix}`}
                        onClick={() => setRevoking(k)}
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

      {revoking && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
          title="Revoke this API key?"
          description={`Key ${revoking.prefix}${revoking.suffix} stops working immediately. This cannot be undone here. Anything using it, including the zv CLI, your apps, and error reporting, needs a new key.`}
          confirmLabel="Revoke key"
          onConfirm={confirmRevoke}
          onError={(error) =>
            toast.error(
              error instanceof Error ? error.message : "Could not revoke the key",
            )
          }
        />
      )}
    </div>
  );
}
