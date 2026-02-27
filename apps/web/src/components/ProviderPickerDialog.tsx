/**
 * Picker dialog for selecting an AI provider.
 * Only shows connected providers.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@clerk/clerk-react";
import { Loader2 } from "lucide-react";
import PickerDialog from "@/components/PickerDialog";
import { jsonBody } from "@/lib/api";
import type { ProviderInfo } from "@zero/core";

interface ProviderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentProvider: string;
  onSelect: (providerId: string) => void;
}

export default function ProviderPickerDialog({
  open,
  onOpenChange,
  currentProvider,
  onSelect,
}: ProviderPickerDialogProps) {
  const { getToken } = useAuth();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const connectedProviders = useMemo(
    () => providers.filter((p) => p.connected),
    [providers],
  );

  useEffect(() => {
    if (!open) return;
    void (async () => {
      setLoading(true);
      try {
        const token = await getToken();
        const resp = await fetch("/api/providers", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await jsonBody<{ providers?: ProviderInfo[] }>(resp);
        setProviders(data.providers ?? []);
      } catch {
        // leave empty
      } finally {
        setLoading(false);
      }
    })();
  }, [open, getToken]);

  const handleSelect = useCallback(
    (provider: ProviderInfo) => {
      onSelect(provider.id);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  return (
    <PickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Switch Provider"
      description="Choose an AI provider for this session"
      placeholder="Search providers..."
      items={connectedProviders}
      filterFn={(p, q) =>
        p.name.toLowerCase().includes(q.toLowerCase()) ||
        p.id.toLowerCase().includes(q.toLowerCase())
      }
      renderItem={(p) => (
        <>
          <span className="truncate font-medium">{p.name}</span>
          {p.id === currentProvider && (
            <span className="ml-auto text-xs text-muted-foreground">current</span>
          )}
        </>
      )}
      onSelect={handleSelect}
      keyFn={(p) => p.id}
      enterVerb="select"
      emptyMessage="No matching providers"
      noItemsMessage="No connected providers. Connect one in Settings → Providers."
      disabled={loading}
      extraFooter={
        loading ? (
          <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading providers...
          </div>
        ) : undefined
      }
    />
  );
}
