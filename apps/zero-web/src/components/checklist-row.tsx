import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// One manually ordered checklist row: the drag handle, the check circle, and
// the text that opens the item. Home's Tasks and the Shopping list share it so
// they look the same. Render it inside a dnd-kit SortableContext.
export function ChecklistRow({ id, text, checkLabel, onCheck, onOpen, openLabel, icon, children, trailing }: {
  id: string;
  text: string;
  checkLabel: string;
  onCheck: () => void;
  onOpen: () => void;
  openLabel?: string;
  icon?: string;
  children?: ReactNode;
  trailing?: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 1 : undefined }} className="group flex items-center gap-3 rounded-xl border bg-card px-4 py-4">
    <button type="button" aria-label={`Reorder "${text}"`} className="shrink-0 cursor-grab touch-none rounded-md px-1 text-muted-foreground active:cursor-grabbing" {...attributes} {...listeners}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>{[4, 8, 12].map((y) => <g key={y}><circle cx="5" cy={y} r="1.4" /><circle cx="11" cy={y} r="1.4" /></g>)}</svg>
    </button>
    <button type="button" aria-label={checkLabel} className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 hover:border-primary" onClick={onCheck} />
    {icon ? <span aria-hidden>{icon}</span> : null}
    <button type="button" className="min-w-0 flex-1 break-words text-left" aria-label={openLabel ?? `Edit "${text}"`} onClick={onOpen}><span>{text}</span>{children}</button>
    {trailing}
  </li>;
}
