/**
 * Picker dialog for selecting a model within the current provider.
 */

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@clerk/clerk-react";
import { Loader2 } from "lucide-react";
import PickerDialog from "@/components/PickerDialog";
import { jsonBody } from "@/lib/api";

interface ModelInfo {
  id: string;
  name: string;
}

interface ModelPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: string;
  currentModel: string;
  onSelect: (modelId: string) => void;
}

export default function ModelPickerDialog({
  open,
  onOpenChange,
  provider,
  currentModel,
  onSelect,
}: ModelPickerDialogProps) {
  const { getToken } = useAuth();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !provider) return;
    void (async () => {
      setLoading(true);
      try {
        const token = await getToken();
        const resp = await fetch(`/api/providers/${provider}/models`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await jsonBody<{ models?: ModelInfo[] }>(resp);
        setModels(data.models ?? []);
      } catch {
        setModels([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, provider, getToken]);

  const handleSelect = useCallback(
    (model: ModelInfo) => {
      onSelect(model.id);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  return (
    <PickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Switch Model"
      description={`Choose a model from ${provider}`}
      placeholder="Search models..."
      items={models}
      filterFn={(m, q) =>
        m.id.toLowerCase().includes(q.toLowerCase()) ||
        m.name.toLowerCase().includes(q.toLowerCase())
      }
      renderItem={(m) => (
        <>
          <span className="truncate font-medium">{m.name}</span>
          {m.id !== m.name && (
            <span className="ml-auto text-xs text-muted-foreground font-mono">
              {m.id}
            </span>
          )}
          {m.id === currentModel && (
            <span className="text-xs text-muted-foreground">current</span>
          )}
        </>
      )}
      onSelect={handleSelect}
      keyFn={(m) => m.id}
      enterVerb="select"
      emptyMessage="No matching models"
      noItemsMessage="No models available for this provider"
      disabled={loading}
      extraFooter={
        loading ? (
          <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading models...
          </div>
        ) : undefined
      }
    />
  );
}
