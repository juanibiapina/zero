import { useEffect, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import {
  Plug,
  Check,
  ExternalLink,
  Key,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { ProviderInfo } from "@zero/core";
import { jsonBody } from "@/lib/api";

/** Providers surfaced first in the available grid (in this order). */
const FEATURED_IDS = ["anthropic", "openai", "google"];

function sortProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return [...providers].sort((a, b) => {
    const ai = FEATURED_IDS.indexOf(a.id);
    const bi = FEATURED_IDS.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });
}

export default function ProvidersPage() {
  const { getToken } = useAuth();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // Connect dialog state
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);

  // OAuth state
  const [pendingOAuth, setPendingOAuth] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState("");

  const connectingProvider = providers.find((p) => p.id === connectingId) ?? null;
  const connected = sortProviders(providers.filter((p) => p.connected));
  const available = sortProviders(providers.filter((p) => !p.connected));

  // ── Data fetching ────────────────────────────────────────────────

  const fetchProviders = async () => {
    try {
      const token = await getToken();
      const resp = await fetch("/api/providers", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await jsonBody<{ providers?: ProviderInfo[] }>(resp);
      setProviders(data.providers ?? []);
    } catch (err) {
      console.error("Failed to fetch providers:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Actions ──────────────────────────────────────────────────────

  const openConnectDialog = (providerId: string) => {
    setConnectingId(providerId);
    setApiKeyInput("");
    setPendingOAuth(false);
    setOauthState(null);
    setOauthCode("");
  };

  const closeConnectDialog = () => {
    setConnectingId(null);
    setApiKeyInput("");
    setPendingOAuth(false);
    setOauthState(null);
    setOauthCode("");
    setSaving(false);
  };

  const startOAuth = async (providerId: string) => {
    const token = await getToken();
    const resp = await fetch(`/api/providers/${providerId}/connect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await jsonBody<{ authUrl?: string; state?: string }>(resp);
    if (data.authUrl) {
      setPendingOAuth(true);
      setOauthState(data.state ?? null);
      window.open(data.authUrl, "_blank");
    }
  };

  const completeOAuth = async (providerId: string) => {
    if (!oauthCode) return;
    setSaving(true);
    try {
      const token = await getToken();
      const resp = await fetch(`/api/providers/${providerId}/callback`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: oauthCode, state: oauthState }),
      });
      const data = await jsonBody<{ success?: boolean }>(resp);
      if (data.success) {
        closeConnectDialog();
        void fetchProviders();
      }
    } finally {
      setSaving(false);
    }
  };

  const saveApiKey = async (providerId: string) => {
    if (!apiKeyInput) return;
    setSaving(true);
    try {
      const token = await getToken();
      const resp = await fetch(`/api/providers/${providerId}/api-key`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey: apiKeyInput }),
      });
      const data = await jsonBody<{ success?: boolean }>(resp);
      if (data.success) {
        closeConnectDialog();
        void fetchProviders();
      }
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async (providerId: string) => {
    const token = await getToken();
    await fetch(`/api/providers/${providerId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    void fetchProviders();
  };

  // ── Auth method label ────────────────────────────────────────────

  const authLabel = (p: ProviderInfo) => {
    if (p.supportsOAuth && p.supportsApiKey) return "API Key or OAuth";
    if (p.supportsOAuth) return "OAuth";
    return "API Key";
  };

  // ── Render ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading providers...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5" />
          <h1 className="text-2xl font-bold">AI Providers</h1>
        </div>
        <p className="text-muted-foreground mt-1">
          Connect AI providers to use with your agent sessions.
        </p>
      </div>

      {/* Connected providers */}
      {connected.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Connected
          </h2>
          <div className="space-y-2">
            {connected.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between rounded-lg border px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-2 w-2 rounded-full bg-green-500" />
                  <span className="font-medium">{provider.name}</span>
                  <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {provider.credentialType === "oauth" ? "OAuth" : "API Key"}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void disconnect(provider.id)}
                >
                  Disconnect
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Available providers */}
      {available.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Available
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {available.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between rounded-lg border px-4 py-3"
              >
                <div>
                  <div className="font-medium">{provider.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {authLabel(provider)}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openConnectDialog(provider.id)}
                >
                  Connect
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Connect dialog */}
      <Dialog
        open={connectingId !== null}
        onOpenChange={(open) => { if (!open) closeConnectDialog(); }}
      >
        <DialogContent>
          {connectingProvider && (
            <>
              <DialogHeader>
                <DialogTitle>Connect {connectingProvider.name}</DialogTitle>
                <DialogDescription>
                  {connectingProvider.supportsOAuth && connectingProvider.supportsApiKey
                    ? "Sign in with OAuth or paste an API key."
                    : connectingProvider.supportsOAuth
                      ? "Sign in with OAuth to connect."
                      : "Enter your API key to connect."}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* OAuth */}
                {connectingProvider.supportsOAuth && (
                  <div className="space-y-2">
                    {pendingOAuth ? (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          Paste the authorization code from the opened tab:
                        </p>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Paste code here..."
                            value={oauthCode}
                            onChange={(e) => setOauthCode(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void completeOAuth(connectingProvider.id);
                            }}
                          />
                          <Button
                            size="sm"
                            onClick={() => void completeOAuth(connectingProvider.id)}
                            disabled={saving || !oauthCode}
                          >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            Submit
                          </Button>
                        </div>
                        <button
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => { setPendingOAuth(false); setOauthCode(""); }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => void startOAuth(connectingProvider.id)}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Connect with OAuth
                      </Button>
                    )}
                  </div>
                )}

                {/* Separator */}
                {connectingProvider.supportsOAuth && connectingProvider.supportsApiKey && !pendingOAuth && (
                  <div className="flex items-center gap-2">
                    <Separator className="flex-1" />
                    <span className="text-xs text-muted-foreground">or</span>
                    <Separator className="flex-1" />
                  </div>
                )}

                {/* API key */}
                {connectingProvider.supportsApiKey && !pendingOAuth && (
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder="API Key..."
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveApiKey(connectingProvider.id);
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void saveApiKey(connectingProvider.id)}
                      disabled={saving || !apiKeyInput}
                    >
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Key className="h-4 w-4" />}
                      Save
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
