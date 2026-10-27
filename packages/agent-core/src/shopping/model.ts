import { generateNKeysBetween } from "fractional-indexing";
import type { MergeableStore, Row } from "tinybase";

import { TodoModel } from "../taskdo/model";

const TABLE = "shoppingItems";

export type ShoppingItem = { id: string; text: string; createdAt: string; sortKey: string | null };

export type ShoppingConflict = "id-conflict" | "missing-item" | "empty-text";

export type ShoppingResult<T> =
  | { ok: true; changed: boolean; value: T }
  | { ok: false; conflict: ShoppingConflict };

type StoredItem = ShoppingItem & { boughtAt: string | null };

function readItem(id: string, row: Row): StoredItem | null {
  const { text, createdAt, sortKey, boughtAt } = row;
  if (typeof text !== "string" || text.trim() === "") return null;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
  return {
    id,
    text,
    createdAt,
    sortKey: typeof sortKey === "string" && sortKey !== "" ? sortKey : null,
    boughtAt: typeof boughtAt === "string" ? boughtAt : null,
  };
}

const publicItem = ({ id, text, createdAt, sortKey }: StoredItem): ShoppingItem => ({ id, text, createdAt, sortKey });

export class ShoppingListModel {
  constructor(
    private readonly store: MergeableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(id: string, text: string): ShoppingResult<ShoppingItem> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, conflict: "empty-text" };
    if (this.store.hasRow(TABLE, id)) {
      const existing = this.get(id);
      return existing && existing.text === trimmed
        ? { ok: true, changed: false, value: publicItem(existing) }
        : { ok: false, conflict: "id-conflict" };
    }
    const open = this.openItems();
    const keyed = open.every((item) => item.sortKey != null);
    const sortKey = keyed ? TodoModel.orderKeyBetween(open.at(-1)?.sortKey ?? null, null) : null;
    this.store.setRow(TABLE, id, { text: trimmed, createdAt: this.now().toISOString(), ...(sortKey ? { sortKey } : {}) });
    return { ok: true, changed: true, value: publicItem(this.get(id)!) };
  }

  edit(id: string, text: string): ShoppingResult<ShoppingItem> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, conflict: "empty-text" };
    const item = this.get(id);
    if (!item) return { ok: false, conflict: "missing-item" };
    if (item.text === trimmed) return { ok: true, changed: false, value: publicItem(item) };
    this.store.setCell(TABLE, id, "text", trimmed);
    return { ok: true, changed: true, value: publicItem(this.get(id)!) };
  }

  move(id: string, toIndex: number): ShoppingResult<ShoppingItem> {
    const item = this.get(id);
    if (!item || item.boughtAt) return { ok: false, conflict: "missing-item" };
    const open = this.openItems();
    const from = open.findIndex((candidate) => candidate.id === id);
    const rest = open.filter((candidate) => candidate.id !== id);
    const to = Math.max(0, Math.min(Math.trunc(toIndex), rest.length));
    if (from === to) return { ok: true, changed: false, value: publicItem(item) };
    const moved = [...rest.slice(0, to), item, ...rest.slice(to)];
    const before = moved[to - 1]?.sortKey ?? null;
    const after = moved[to + 1]?.sortKey ?? null;
    const keyed = moved.every((candidate) => candidate.id === id || candidate.sortKey != null);
    if (keyed && (before == null || after == null || before < after)) {
      this.store.setCell(TABLE, id, "sortKey", TodoModel.orderKeyBetween(before, after));
    } else {
      const keys = generateNKeysBetween(null, null, moved.length);
      moved.forEach((candidate, index) => this.store.setCell(TABLE, candidate.id, "sortKey", keys[index]));
    }
    return { ok: true, changed: true, value: publicItem(this.get(id)!) };
  }

  buy(id: string): ShoppingResult<ShoppingItem> {
    const item = this.get(id);
    if (!item) return { ok: false, conflict: "missing-item" };
    if (item.boughtAt) return { ok: true, changed: false, value: publicItem(item) };
    this.store.setCell(TABLE, id, "boughtAt", this.now().toISOString());
    return { ok: true, changed: true, value: publicItem(item) };
  }

  unbuy(id: string): ShoppingResult<ShoppingItem> {
    const item = this.get(id);
    if (!item) return { ok: false, conflict: "missing-item" };
    if (!item.boughtAt) return { ok: true, changed: false, value: publicItem(item) };
    this.store.delCell(TABLE, id, "boughtAt");
    return { ok: true, changed: true, value: publicItem(item) };
  }

  open(): ShoppingItem[] {
    return this.openItems().map(publicItem);
  }

  private get(id: string): StoredItem | null {
    return this.store.hasRow(TABLE, id) ? readItem(id, this.store.getRow(TABLE, id)) : null;
  }

  private openItems(): StoredItem[] {
    return this.store.getRowIds(TABLE)
      .flatMap((id) => readItem(id, this.store.getRow(TABLE, id)) ?? [])
      .filter((item) => !item.boughtAt)
      .sort((a, b) => TodoModel.compareTasks(a, b) || a.id.localeCompare(b.id));
  }
}
