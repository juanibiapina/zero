import { createMergeableStore, type MergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { ShoppingListModel } from "./model";

function list(store: MergeableStore = createMergeableStore()) {
  let minute = 0;
  const model = new ShoppingListModel(store, () => new Date(Date.UTC(2026, 9, 26, 10, minute++)));
  const texts = () => model.open().map((item) => item.text);
  return { store, model, texts };
}

function withItems(...texts: string[]) {
  const shopping = list();
  texts.forEach((text, index) => shopping.model.add(`i${index + 1}`, text));
  return shopping;
}

describe("Shopping list", () => {
  it("adds items at the bottom with trimmed text", () => {
    const { model, texts } = withItems("Milk", "  Eggs  ");
    expect(texts()).toEqual(["Milk", "Eggs"]);
    expect(model.add("i3", "   ")).toEqual({ ok: false, conflict: "empty-text" });
  });

  it("treats a repeated add with the same id and text as unchanged", () => {
    const { model, texts } = withItems("Milk");
    expect(model.add("i1", "Milk")).toMatchObject({ ok: true, changed: false });
    expect(model.add("i1", "Bread")).toEqual({ ok: false, conflict: "id-conflict" });
    expect(texts()).toEqual(["Milk"]);
  });

  it("edits the text and refuses empty text", () => {
    const { model, texts } = withItems("Milk");
    expect(model.edit("i1", " Oat milk ")).toMatchObject({ ok: true, changed: true });
    expect(model.edit("i1", "")).toEqual({ ok: false, conflict: "empty-text" });
    expect(model.edit("nope", "x")).toEqual({ ok: false, conflict: "missing-item" });
    expect(texts()).toEqual(["Oat milk"]);
  });

  it("moves an item to the top, the middle, and the bottom", () => {
    const { model, texts } = withItems("A", "B", "C", "D");
    model.move("i4", 0);
    expect(texts()).toEqual(["D", "A", "B", "C"]);
    model.move("i4", 2);
    expect(texts()).toEqual(["A", "B", "D", "C"]);
    model.move("i1", 99);
    expect(texts()).toEqual(["B", "D", "C", "A"]);
    model.move("i3", 1);
    expect(texts()).toEqual(["B", "C", "D", "A"]);
  });

  it("moves items among rows that have no order yet", () => {
    const { store, model, texts } = list();
    store.setRow("shoppingItems", "a", { text: "A", createdAt: "2026-10-26T09:00:00.000Z" });
    store.setRow("shoppingItems", "b", { text: "B", createdAt: "2026-10-26T09:01:00.000Z" });
    store.setRow("shoppingItems", "c", { text: "C", createdAt: "2026-10-26T09:02:00.000Z" });
    model.move("c", 1);
    expect(texts()).toEqual(["A", "C", "B"]);
    model.add("d", "D");
    expect(texts()).toEqual(["A", "C", "B", "D"]);
  });

  it("keeps a new item at the bottom after the list was reordered", () => {
    const { model, texts } = withItems("A", "B");
    model.move("i2", 0);
    model.add("i3", "C");
    expect(texts()).toEqual(["B", "A", "C"]);
    model.move("i3", 1);
    expect(texts()).toEqual(["B", "C", "A"]);
  });

  it("hides a bought item and restores it in its place", () => {
    const { model, texts } = withItems("A", "B", "C");
    model.move("i3", 0);
    model.buy("i1");
    expect(texts()).toEqual(["C", "B"]);
    expect(model.buy("i1")).toMatchObject({ ok: true, changed: false });
    model.unbuy("i1");
    expect(texts()).toEqual(["C", "A", "B"]);
  });

  it("keeps a buy and an edit made on two devices", () => {
    const phone = withItems("Milk", "Eggs");
    const laptop = list(createMergeableStore());
    laptop.store.setMergeableContent(phone.store.getMergeableContent());

    phone.model.buy("i1");
    laptop.model.edit("i1", "Oat milk");
    laptop.model.move("i2", 0);
    phone.store.merge(laptop.store);

    expect(phone.texts()).toEqual(["Eggs"]);
    phone.model.unbuy("i1");
    expect(phone.texts()).toEqual(["Eggs", "Oat milk"]);
  });

  it("skips rows it cannot read", () => {
    const { store, texts } = withItems("Milk");
    store.setRow("shoppingItems", "bad", { text: "", createdAt: "2026-10-26T10:00:00.000Z" });
    store.setRow("shoppingItems", "worse", { text: "Bread", createdAt: "yesterday" });
    expect(texts()).toEqual(["Milk"]);
  });
});
