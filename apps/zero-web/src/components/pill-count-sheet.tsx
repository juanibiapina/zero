import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";

// Asks for one whole number of pills: the amount bought for Restock, or the
// pills on hand for Set count.
export function PillCountSheet({ title, initial, min = 1, onSave, onClose }: {
  title: string;
  initial: number | null;
  min?: number;
  onSave: (count: number) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial === null ? "" : String(initial));
  const value = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  const valid = value !== null && value >= min;
  return <Sheet open onClose={onClose} title={title}>
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (valid) onSave(value); }}>
      <label className="flex items-center gap-2"><Input aria-label={title} type="number" inputMode="numeric" min={min} step={1} autoFocus value={text} onChange={(event) => setText(event.target.value)} />pills</label>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!valid}>Save</Button></div>
    </form>
  </Sheet>;
}
