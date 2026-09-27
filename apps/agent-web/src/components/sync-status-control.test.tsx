import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { TodoDataContextProvider, type TodoData } from "@/lib/todo-data";
import { SyncStatusControl } from "./sync-status-control";

function renderStatus(sync: TodoData["sync"]) {
  const data: TodoData = {
    replica: null,
    ready: true,
    connected: sync.phase === "synced",
    sync,
    durable: true,
    error: null,
    durabilityError: null,
    recoveries: [],
  };
  return render(
    <MemoryRouter>
      <TodoDataContextProvider value={data}>
        <SyncStatusControl />
      </TodoDataContextProvider>
    </MemoryRouter>,
  );
}

describe("SyncStatusControl", () => {
  it("opens details with the exact last successful sync time", () => {
    const lastSyncedAt = "2026-09-27T11:45:00.000Z";
    renderStatus({ phase: "synced", lastSyncedAt });

    fireEvent.click(screen.getByRole("button", { name: "Synced" }));

    expect(screen.getByText("Your saved changes are up to date.")).toBeInTheDocument();
    expect(screen.getByText(new Date(lastSyncedAt).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  it("reports connecting without claiming to be offline", () => {
    renderStatus({ phase: "connecting", lastSyncedAt: "2026-09-27T11:45:00.000Z" });

    expect(screen.getByRole("button", { name: "Connecting" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Offline" })).not.toBeInTheDocument();
  });
});
