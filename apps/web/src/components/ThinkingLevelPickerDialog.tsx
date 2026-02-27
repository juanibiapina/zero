/**
 * Picker dialog for selecting a thinking/reasoning level.
 * Shows static list of levels, filtered by model capabilities.
 */

import { useCallback, useMemo } from "react";
import PickerDialog from "@/components/PickerDialog";
import { THINKING_LEVELS, type ThinkingLevel, type ThinkingLevelInfo } from "@zero/core";

interface ThinkingLevelPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentLevel: ThinkingLevel;
  onSelect: (level: ThinkingLevel) => void;
  /** Whether the current model supports "xhigh" thinking level. */
  supportsXhigh?: boolean;
}

export default function ThinkingLevelPickerDialog({
  open,
  onOpenChange,
  currentLevel,
  onSelect,
  supportsXhigh = false,
}: ThinkingLevelPickerDialogProps) {
  const levels = useMemo(
    () => (supportsXhigh ? THINKING_LEVELS : THINKING_LEVELS.filter((l) => l.id !== "xhigh")),
    [supportsXhigh],
  );

  const handleSelect = useCallback(
    (level: ThinkingLevelInfo) => {
      onSelect(level.id);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  return (
    <PickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Switch Thinking Level"
      description="Choose a reasoning level for the AI"
      placeholder="Search levels..."
      items={levels}
      filterFn={(l, q) =>
        l.label.toLowerCase().includes(q.toLowerCase()) ||
        l.description.toLowerCase().includes(q.toLowerCase())
      }
      renderItem={(l) => (
        <>
          <span className="truncate font-medium">{l.label}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {l.description}
          </span>
          {l.id === currentLevel && (
            <span className="text-xs text-muted-foreground">current</span>
          )}
        </>
      )}
      onSelect={handleSelect}
      keyFn={(l) => l.id}
      enterVerb="select"
      emptyMessage="No matching levels"
      noItemsMessage="No levels available"
    />
  );
}
