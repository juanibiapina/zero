import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { defaultToastController } from "@zero/agent-core";

import { ShoppingPage } from "./ShoppingPage";
import { TodoDataContextProvider, type TodoData } from "@/lib/todo-data";
import { createInMemoryTodoData } from "@/testing/in-memory-todo-data";

async function renderPage(items: string[] = ["Milk", "Eggs", "Bread"]) {
  const { data, replica } = createInMemoryTodoData();
  for (const item of items) await replica.shopping.add(item);
  const value: TodoData = { ...data, replica };
  render(<TodoDataContextProvider value={value}><MemoryRouter><ShoppingPage /></MemoryRouter></TodoDataContextProvider>);
  return { replica, texts: () => replica.snapshot().shopping.map((item) => item.text) };
}

function measureRows() {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.tagName === "LI" && this.closest('[aria-label="Shopping list"]')) {
      const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
      return new DOMRect(0, index * 60, 300, 50);
    }
    return new DOMRect(0, 0, 0, 0);
  });
}

async function moveUp(text: string, steps: number) {
  const handle = screen.getByRole("button", { name: `Reorder "${text}"` });
  handle.focus();
  await act(async () => { fireEvent.keyDown(handle, { key: " ", code: "Space" }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  for (let i = 0; i < steps; i++) {
    await act(async () => { fireEvent.keyDown(document, { key: "ArrowUp", code: "ArrowUp" }); });
  }
  await act(async () => { fireEvent.keyDown(document, { key: " ", code: "Space" }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("ShoppingPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    defaultToastController.dismiss();
  });

  it("adds an item at the bottom without a toast", async () => {
    const { texts } = await renderPage();
    expect(screen.getByRole("heading", { name: "Shopping list", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Add to shopping list" }), { target: { value: "Coffee" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add" })); });
    expect(await screen.findByRole("button", { name: 'Edit "Coffee"' })).toBeInTheDocument();
    expect(texts()).toEqual(["Milk", "Eggs", "Bread", "Coffee"]);
    expect(defaultToastController.getSnapshot()).toEqual([]);
  });

  it("removes a bought item, with Undo", async () => {
    const { texts } = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: 'Mark "Eggs" bought' }));
    await waitFor(() => expect(screen.queryByRole("button", { name: 'Edit "Eggs"' })).toBeNull());
    const [toast] = defaultToastController.getSnapshot();
    expect(toast?.message).toBe("Bought");
    await act(async () => toast?.action?.onPress());
    expect(await screen.findByRole("button", { name: 'Edit "Eggs"' })).toBeInTheDocument();
    expect(texts()).toEqual(["Milk", "Eggs", "Bread"]);
  });

  it("reorders items by dragging with the keyboard", async () => {
    measureRows();
    const { texts } = await renderPage();
    await moveUp("Bread", 2);
    await waitFor(() => expect(texts()).toEqual(["Bread", "Milk", "Eggs"]));
  });

  it("edits an item and saves it when the sheet closes", async () => {
    const { texts } = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: 'Edit "Milk"' }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Item text" }), { target: { value: "Oat milk tomorrow" } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(texts()).toEqual(["Oat milk tomorrow", "Eggs", "Bread"]));
  });

  it("marks an item bought from its sheet", async () => {
    const { texts } = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: 'Edit "Bread"' }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark bought" }));
    await waitFor(() => expect(texts()).toEqual(["Milk", "Eggs"]));
    expect(defaultToastController.getSnapshot()[0]?.message).toBe("Bought");
  });
});
