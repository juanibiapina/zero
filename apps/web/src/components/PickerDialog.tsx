import { useState, useEffect, useRef, useMemo } from "react";
import { Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────

export interface PickerDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  placeholder: string;
  items: T[];
  filterFn: (item: T, query: string) => boolean;
  renderItem: (item: T, selected: boolean) => React.ReactNode;
  onSelect: (item: T) => void;
  keyFn: (item: T) => string;
  disabled?: boolean;
  enterVerb?: string;
  emptyMessage?: string;
  noItemsMessage?: string;
  groupBy?: (item: T) => string;
  /** Extra footer content rendered above the default hint bar (e.g. error or loading) */
  extraFooter?: React.ReactNode;
}

export default function PickerDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  items,
  filterFn,
  renderItem,
  onSelect,
  keyFn,
  disabled = false,
  enterVerb = "select",
  emptyMessage = "No matching results",
  noItemsMessage = "Nothing to show",
  groupBy,
  extraFooter,
}: PickerDialogProps<T>) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);

  // Filter items by query
  const filtered = useMemo(
    () =>
      query === ""
        ? items
        : items.filter((item) => filterFn(item, query)),
    [items, query, filterFn],
  );

  // Group filtered items (only when groupBy is provided)
  const grouped = useMemo(() => {
    if (!groupBy) return null;
    const map = new Map<string, T[]>();
    for (const item of filtered) {
      const key = groupBy(item);
      const list = map.get(key);
      if (list) {
        list.push(item);
      } else {
        map.set(key, [item]);
      }
    }
    return map;
  }, [filtered, groupBy]);

  // Reset state when dialog opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  // Keep selectedIndex in bounds
  useEffect(() => {
    setSelectedIndex((prev) =>
      filtered.length === 0 ? 0 : Math.min(prev, filtered.length - 1),
    );
  }, [filtered.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-picker-item]");
    const item = items[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < filtered.length - 1 ? prev + 1 : prev,
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex]);
        }
        break;
    }
  };

  // Render flat list (no grouping)
  const renderFlatList = () =>
    filtered.map((item, index) => (
      <div
        key={keyFn(item)}
        data-picker-item
        role="button"
        tabIndex={-1}
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors cursor-pointer",
          index === selectedIndex
            ? "bg-accent text-accent-foreground"
            : "text-foreground hover:bg-muted/50",
        )}
        onClick={() => !disabled && onSelect(item)}
        onMouseEnter={() => setSelectedIndex(index)}
      >
        {renderItem(item, index === selectedIndex)}
      </div>
    ));

  // Render grouped list
  const renderGroupedList = () => {
    if (!grouped) return null;
    let flatIndex = -1;

    return [...grouped.entries()].map(([group, groupItems]) => (
      <div key={group}>
        <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/60">
          {group}
        </div>
        {groupItems.map((item) => {
          flatIndex++;
          const idx = flatIndex;
          return (
            <div
              key={keyFn(item)}
              data-picker-item
              role="button"
              tabIndex={-1}
              className={cn(
                "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors cursor-pointer",
                idx === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-muted/50",
              )}
              onClick={() => !disabled && onSelect(item)}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              {renderItem(item, idx === selectedIndex)}
            </div>
          );
        })}
      </div>
    ));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl gap-0 p-0 overflow-hidden"
        showCloseButton={false}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            disabled={disabled}
            className="border-0 shadow-none focus-visible:ring-0 h-11"
            autoFocus
          />
        </div>

        {/* Item list */}
        <div ref={listRef} className="max-h-[28rem] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {items.length === 0 ? noItemsMessage : emptyMessage}
            </div>
          )}

          {grouped ? renderGroupedList() : renderFlatList()}
        </div>

        {/* Extra footer (error, loading indicator, etc.) */}
        {extraFooter}

        {/* Footer hint */}
        {!disabled && filtered.length > 0 && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              ↑↓
            </kbd>{" "}
            navigate{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              ↵
            </kbd>{" "}
            {enterVerb}{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              esc
            </kbd>{" "}
            close
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
