import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const TEXT_CLASS = "block w-full whitespace-pre-wrap break-words text-base text-muted-foreground";

export function ProjectDescription({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (next: string | null) => void;
}) {
  const [text, setText] = useState(value ?? "");
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const showField = editing || text.trim() === "";

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!showField || !field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [showField, text]);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (showField || expanded || !element) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showField, expanded, text]);

  const commit = () => {
    setEditing(false);
    const next = text.trim() === "" ? null : text;
    if (next !== (value ?? null)) onCommit(next);
  };

  if (showField) {
    return (
      <textarea
        ref={fieldRef}
        value={text}
        aria-label="Project description"
        rows={1}
        autoFocus={editing}
        placeholder="What outcome are you after, and why does it matter?"
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onFocus={(e) => {
          setEditing(true);
          const end = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(end, end);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        className={cn(TEXT_CLASS, "resize-none overflow-hidden border-0 bg-transparent p-0 outline-none placeholder:text-muted-foreground/60 focus-visible:ring-0")}
      />
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="w-full cursor-text rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="sr-only">Edit project description: </span>
        <span ref={textRef} className={cn(TEXT_CLASS, !expanded && "line-clamp-4")}>
          {text}
        </span>
      </button>
      {clamped ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="rounded-sm text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {expanded ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}
