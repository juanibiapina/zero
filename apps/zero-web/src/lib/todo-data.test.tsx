import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodoDataProvider, useTodoData } from "./todo-data";

const auth = vi.hoisted<{ userId: string | null }>(() => ({ userId: "A" }));
vi.mock("@clerk/react", () => ({ useAuth: () => auth }));

function Probe() {
  const data = useTodoData();
  return <div>
    <p>{data.authenticatedFeatures ? "Account workspace" : "Guest workspace"}</p>
    {data.replica?.snapshot().tasks.map((task) => <p key={task.id}>{task.text}</p>)}
    <button onClick={() => { void data.replica!.tasks.add(`Task for ${auth.userId ?? "guest"}`).isPersisted.promise; }}>Create task</button>
  </div>;
}

beforeEach(() => {
  auth.userId = "A";
  localStorage.clear();
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: <T,>(name: string, callback: () => Promise<T>) => {
    const operation = (tails.get(name) ?? Promise.resolve()).catch(() => {}).then(callback);
    tails.set(name, operation);
    return operation;
  } } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  vi.stubGlobal("BroadcastChannel", undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("TodoDataProvider", () => {
  it("hides the previous account immediately and restores each account's own work", async () => {
    const view = render(<TodoDataProvider><Probe /></TodoDataProvider>);
    await screen.findByText("Account workspace");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText("Task for A");
    auth.userId = "B";
    view.rerender(<TodoDataProvider><Probe /></TodoDataProvider>);
    expect(screen.queryByText("Task for A")).toBeNull();
    await screen.findByText("Account workspace");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText("Task for B");
    auth.userId = "A";
    view.rerender(<TodoDataProvider><Probe /></TodoDataProvider>);
    expect(screen.queryByText("Task for B")).toBeNull();
    expect(await screen.findByText("Task for A")).toBeInTheDocument();
  });

  it("opens a guest after sign-out and adopts its work alongside existing account work", async () => {
    const view = render(<TodoDataProvider><Probe /></TodoDataProvider>);
    await screen.findByText("Account workspace");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText("Task for A");
    auth.userId = null;
    view.rerender(<TodoDataProvider><Probe /></TodoDataProvider>);
    expect(screen.queryByText("Task for A")).toBeNull();
    await screen.findByText("Guest workspace");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText("Task for guest");
    auth.userId = "A";
    view.rerender(<TodoDataProvider><Probe /></TodoDataProvider>);
    await waitFor(() => {
      expect(screen.getByText("Account workspace")).toBeInTheDocument();
      expect(screen.getByText("Task for A")).toBeInTheDocument();
      expect(screen.getByText("Task for guest")).toBeInTheDocument();
    });
  });
});
