import { render, screen, waitFor } from "@testing-library/react";
import type { TaskdoReplica } from "@zero/agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TodoDataProvider, useTodoData } from "./todo-data";

const auth = vi.hoisted<{ userId: string | null }>(() => ({ userId: "A" }));
const openReplica = vi.hoisted(() => vi.fn());

vi.mock("@clerk/react", () => ({ useAuth: () => auth }));
vi.mock("./browser-taskdo-replica", () => ({ openBrowserTaskdoReplica: openReplica }));

function replica(accountId: string, close: () => Promise<void>) {
  return {
    durable: true,
    durabilityError: null,
    close,
    snapshot: () => ({
      tasks: [],
      projects: [],
      conditions: [],
      recoveries: [{ table: "tasks", id: accountId, text: accountId, reason: "Invalid Task" }],
    }),
  } as unknown as TaskdoReplica & { durable: boolean; durabilityError: string | null };
}

function Probe() {
  const data = useTodoData();
  return <div>account:{data.recoveries[0]?.id}</div>;
}

describe("TodoDataProvider", () => {
  beforeEach(() => {
    auth.userId = "A";
    openReplica.mockReset();
  });

  it("wires Clerk account changes through serialized replica ownership", async () => {
    const order: string[] = [];
    openReplica.mockImplementation(async (accountId: string) => {
      order.push(`open ${accountId}`);
      return replica(accountId, async () => { order.push(`close ${accountId}`); });
    });
    const view = render(<TodoDataProvider><Probe /></TodoDataProvider>);
    expect(await screen.findByText("account:A")).toBeInTheDocument();

    auth.userId = "B";
    view.rerender(<TodoDataProvider><Probe /></TodoDataProvider>);
    expect(screen.queryByText("account:A")).not.toBeInTheDocument();
    expect(await screen.findByText("account:B")).toBeInTheDocument();
    expect(order).toEqual(["open A", "close A", "open B"]);

    view.unmount();
    await waitFor(() => expect(order).toEqual(["open A", "close A", "open B", "close B"]));
  });
});
