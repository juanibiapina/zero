import { useEffect, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import {
  Plug,
  Check,
  X,
  ExternalLink,
  Key,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { ProviderInfo } from "@zero/core";
import { jsonBody } from "@/lib/api";

export default function ProvidersPage() {
  const { getToken } = useAuth();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [oauthCode, setOauthCode] = useState<Record<string, string>>({});
  const [pendingOAuth, setPendingOAuth] = useState<string | null>(null);
  const [oauthState, setOauthState] = useState<string | null>(null);

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

  const startOAuth = async (providerId: string) => {
    const token = await getToken();
    const resp = await fetch(`/api/providers/${providerId}/connect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await jsonBody<{ authUrl?: string; state?: string }>(resp);
    if (data.authUrl) {
      setPendingOAuth(providerId);
      setOauthState(data.state ?? null);
      window.open(data.authUrl, "_blank");
    }
  };

  const completeOAuth = async (providerId: string) => {
    const code = oauthCode[providerId];
    if (!code) return;

    const token = await getToken();
    const resp = await fetch(`/api/providers/${providerId}/callback`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code, state: oauthState }),
    });
    const data = await jsonBody<{ success?: boolean }>(resp);
    if (data.success) {
      setPendingOAuth(null);
      setOauthState(null);
      setOauthCode((prev) => ({ ...prev, [providerId]: "" }));
      void fetchProviders();
    }
  };

  const saveApiKey = async (providerId: string) => {
    const apiKey = apiKeyInputs[providerId];
    if (!apiKey) return;

    const token = await getToken();
    const resp = await fetch(`/api/providers/${providerId}/api-key`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey }),
    });
    const data = await jsonBody<{ success?: boolean }>(resp);
    if (data.success) {
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: "" }));
      void fetchProviders();
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

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading providers...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Plug className="h-5 w-5" />
        <h1 className="text-2xl font-bold">AI Providers</h1>
      </div>
      <p className="text-muted-foreground">
        Connect AI providers to use with your agent sessions.
      </p>

      <div className="space-y-4">
        {providers.map((provider) => (
          <div key={provider.id} className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="font-medium">{provider.name}</div>
                {provider.connected ? (
                  <span className="flex items-center gap-1 text-xs text-green-600">
                    <Check className="h-3 w-3" />
                    Connected ({provider.credentialType})
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <X className="h-3 w-3" />
                    Not connected
                  </span>
                )}
              </div>
              {provider.connected && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void disconnect(provider.id)}
                >
                  Disconnect
                </Button>
              )}
            </div>

            {!provider.connected && (
              <>
                {/* OAuth connect */}
                {provider.supportsOAuth && (
                  <div className="space-y-2">
                    {pendingOAuth === provider.id ? (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          Paste the authorization code from the opened tab:
                        </p>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Paste code here..."
                            value={oauthCode[provider.id] ?? ""}
                            onChange={(e) =>
                              setOauthCode((prev) => ({
                                ...prev,
                                [provider.id]: e.target.value,
                              }))
                            }
                          />
                          <Button
                            size="sm"
                            onClick={() => void completeOAuth(provider.id)}
                          >
                            Submit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPendingOAuth(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void startOAuth(provider.id)}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Connect with OAuth
                      </Button>
                    )}
                  </div>
                )}

                {/* Separator between OAuth and API key if both available */}
                {provider.supportsOAuth && provider.supportsApiKey && (
                  <div className="flex items-center gap-2">
                    <Separator className="flex-1" />
                    <span className="text-xs text-muted-foreground">or</span>
                    <Separator className="flex-1" />
                  </div>
                )}

                {/* API key input */}
                {provider.supportsApiKey && (
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder="API Key..."
                      value={apiKeyInputs[provider.id] ?? ""}
                      onChange={(e) =>
                        setApiKeyInputs((prev) => ({
                          ...prev,
                          [provider.id]: e.target.value,
                        }))
                      }
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void saveApiKey(provider.id)}
                    >
                      <Key className="h-4 w-4" />
                      Save
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
