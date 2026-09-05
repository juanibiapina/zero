import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import {
  createInMemoryApi,
  createInMemoryTasksApi,
  type Capture,
  type CapturesApi,
  type CapturesRest,
  type Task,
  type TasksApi,
  type TasksRest,
} from "@zero/agent-core";

import { HomePage } from "./HomePage";

// Give the real page fresh in-memory collections per test. The array-backed
// REST boundary keeps each interaction deterministic without OPFS or network.
const h = vi.hoisted(() => ({
  api: null as CapturesApi | null,
  tasksApi: null as TasksApi | null,
}));
vi.mock("@/lib/captures-collection", () => ({
  getCapturesApi: () => Promise.resolve(h.api),
}));
vi.mock("@/lib/tasks-collection", () => ({
  getTasksApi: () => Promise.resolve(h.tasksApi),
}));

const capture = (id: string, text: string): Capture => ({
  id,
  text,
  createdAt: `2023-01-0${id}T00:00:00.000Z`,
  processedAt: null,
  showUpDate: null,
  sortKey: null,
});

function fakeRest(initial: Capture[]): CapturesRest {
  const server = initial.map((item) => ({ ...item }));
  return {
    fetchCaptures: async () => server.map((item) => ({ ...item })),
    addCapture: async ({ id, text }) => {
      const row = capture(id, text);
      server.push(row);
      return { ...row };
    },
    processCapture: async (id) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no capture ${id}`);
      row.processedAt = new Date().toISOString();
      return { ...row };
    },
    editCapture: async (id, text) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no capture ${id}`);
      row.text = text;
      return { ...row };
    },
    rescheduleCapture: async (id, showUpDate) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no capture ${id}`);
      row.showUpDate = showUpDate;
      return { ...row };
    },
    reorderCapture: async (id, sortKey) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no capture ${id}`);
      row.sortKey = sortKey;
      return { ...row };
    },
  };
}

const taskRow = (id: string, text: string): Task => ({
  id,
  text,
  showUpDate: "2023-01-01",
  createdAt: `2023-01-0${id}T00:00:00.000Z`,
  completedAt: null,
});

function fakeTasksRest(initial: Task[]): TasksRest {
  const server = initial.map((item) => ({ ...item }));
  return {
    fetchTasks: async () => server.map((item) => ({ ...item })),
    addTask: async ({ id, text, showUpDate }) => {
      const row: Task = {
        id,
        text,
        showUpDate,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      server.push(row);
      return { ...row };
    },
    completeTask: async (id) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.completedAt = new Date().toISOString();
      return { ...row };
    },
  };
}

function setApi(initial: Capture[], tasks: Task[] = []) {
  h.api = createInMemoryApi({
    queryClient: new QueryClient(),
    rest: fakeRest(initial),
  });
  h.tasksApi = createInMemoryTasksApi({
    queryClient: new QueryClient(),
    rest: fakeTasksRest(tasks),
  });
}

describe("HomePage", () => {
  afterEach(() => {
    h.api = null;
    h.tasksApi = null;
  });

  it("adds a task from the Task quick-add mode", async () => {
    setApi([]);
    render(<HomePage />);

    fireEvent.click(await screen.findByRole("radio", { name: "task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Add a task" }), {
      target: { value: "call the dentist" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Complete "call the dentist"' }),
      ).toBeInTheDocument(),
    );
  });

  it("completes a task from the top region", async () => {
    setApi([], [taskRow("1", "mail the letter")]);
    render(<HomePage />);

    const complete = await screen.findByRole("button", {
      name: 'Complete "mail the letter"',
    });
    await act(async () => {
      fireEvent.click(complete);
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: 'Complete "mail the letter"' }),
      ).toBeNull(),
    );
  });

  it("edits a capture from its detail sheet", async () => {
    setApi([capture("1", "buy milk")]);
    render(<HomePage />);

    fireEvent.click(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    );
    const input = screen.getByRole("textbox", { name: "Capture text" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "buy oat milk" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Edit "buy oat milk"' }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("preserves the stored text when the sheet draft is empty", async () => {
    setApi([capture("1", "buy milk")]);
    render(<HomePage />);

    fireEvent.click(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Capture text" }), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: 'Edit "buy milk"' }),
    ).toBeInTheDocument();
  });

  it("commits a changed draft when Escape dismisses the sheet", async () => {
    setApi([capture("1", "buy milk")]);
    render(<HomePage />);

    fireEvent.click(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Capture text" }), {
      target: { value: "buy oat milk" },
    });
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Edit "buy oat milk"' }),
      ).toBeInTheDocument(),
    );
  });

  it("closes an unchanged capture with the sheet Close button", async () => {
    setApi([capture("1", "buy milk")]);
    render(<HomePage />);

    fireEvent.click(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByRole("button", { name: 'Edit "buy milk"' }),
    ).toBeInTheDocument();
  });
});
