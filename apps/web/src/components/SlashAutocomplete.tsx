import { useEffect, useRef, useMemo, useCallback } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PromptTemplate } from "@zero/core";

interface SlashAutocompleteProps {
  input: string;
  templates: PromptTemplate[];
  onSelect: (template: PromptTemplate) => void;
  /** Ref to the textarea — used for keyboard event capture */
  anchorRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Currently selected index — lifted to parent */
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
}

/**
 * Autocomplete dropdown that appears when the user types "/" at the start of input.
 * Shows matching templates filtered by partial slug.
 *
 * Selection state is owned by the parent to avoid ref-during-render issues.
 */
export function SlashAutocomplete({
  input,
  templates,
  onSelect,
  anchorRef,
  selectedIndex,
  onSelectedIndexChange,
}: SlashAutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Only show when input starts with "/" and we're still typing the slug (no space yet)
  const slashMatch = input.match(/^\/(\S*)$/);
  const isVisible = slashMatch !== null && templates.length > 0;
  const partial = slashMatch?.[1] ?? "";

  const filtered = useMemo(
    () =>
      isVisible
        ? templates.filter(
            (t) =>
              t.slug.startsWith(partial) ||
              t.name.toLowerCase().startsWith(partial.toLowerCase())
          )
        : [],
    [isVisible, templates, partial]
  );

  const showDropdown = filtered.length > 0;

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!showDropdown) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        onSelectedIndexChange(Math.min(selectedIndex + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onSelectedIndexChange(Math.max(selectedIndex - 1, 0));
      } else if (e.key === "Tab" || (e.key === "Enter" && filtered.length > 0)) {
        e.preventDefault();
        e.stopPropagation();
        onSelect(filtered[selectedIndex]);
      }
    },
    [showDropdown, filtered, selectedIndex, onSelect, onSelectedIndexChange]
  );

  // Attach keyboard handler to the textarea
  useEffect(() => {
    const el = anchorRef.current;
    if (!el || !showDropdown) return;

    el.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => el.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [anchorRef, showDropdown, handleKeyDown]);

  if (!showDropdown) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50">
      <div
        ref={listRef}
        className="rounded-lg border bg-popover shadow-md max-h-[200px] overflow-y-auto py-1"
      >
        {filtered.map((t, i) => (
          <button
            key={t.id}
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent",
              i === selectedIndex && "bg-accent"
            )}
            onMouseDown={(e) => {
              e.preventDefault(); // Don't blur the textarea
              onSelect(t);
            }}
            onMouseEnter={() => onSelectedIndexChange(i)}
          >
            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="font-mono text-xs text-muted-foreground">/{t.slug}</span>
            <span className="text-foreground">{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}


