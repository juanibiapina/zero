import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import {
  createInMemoryApi,
  createInMemoryProjectsApi,
  createInMemoryTasksApi,
  createInMemoryWaitsApi,
  type CapturesApi,
  type Project,
  type ProjectsApi,
  type ProjectsRest,
  type ProjectStatus,
  type Task,
  type TasksApi,
  type TasksRest,
  type WaitsApi,
  type WaitsRest,
} from "@zero/agent-core";

import { ProjectsPage } from "./ProjectsPage";

// The page reads its data layers through getProjectsApi() / getTasksApi(); hand
// each a fresh in-memory collection per test (backed by an array "server"), so
// the real ProjectsPage, the shared collections, and the undoable-leave hook are
// all exercised without OPFS or the network.
const h = vi.hoisted(() => ({
  api: null as ProjectsApi | null,
  tasksApi: null as TasksApi | null,
  waitsApi: null as WaitsApi | null,
  capturesApi: null as CapturesApi | null,
}));
vi.mock("@/lib/projects-collection", () => ({
  getProjectsApi: () => Promise.resolve(h.api),
}));
vi.mock("@/lib/tasks-collection", () => ({
  getTasksApi: () => Promise.resolve(h.tasksApi),
}));
vi.mock("@/lib/waits-collection", () => ({
  getWaitsApi: () => Promise.resolve(h.waitsApi),
}));
vi.mock("@/lib/captures-collection", () => ({
  getCapturesApi: () => Promise.resolve(h.capturesApi),
}));

function fakeWaitsRest(): WaitsRest {
  const server: import("@zero/agent-core").WaitingCondition[] = [];
  return {
    fetchWaits: async () => server.map((c) => ({ ...c })),
    addWaitingCondition: async (c) => {
      const row = {
        ...c,
        resolvedAt: null,
        createdAt: new Date().toISOString(),
      };
      server.push(row);
      return { ...row };
    },
    resolveWaitingCondition: async (id) => {
      const row = server.find((c) => c.id === id);
      if (!row) throw new Error(`no condition ${id}`);
      row.resolvedAt = new Date().toISOString();
      return { ...row };
    },
    deleteWaitingCondition: async (id) => {
      const i = server.findIndex((c) => c.id === id);
      if (i >= 0) server.splice(i, 1);
    },
  };
}

const project = (
  id: string,
  title: string,
  status: ProjectStatus = "next",
  icon = "📁",
): Project => ({
  id,
  title,
  icon,
  description: null,
  status,
  createdAt: `2023-01-0${id.slice(-1)}T00:00:00.000Z`,
});

function fakeRest(initial: Project[]): ProjectsRest {
  const server = initial.map((p) => ({ ...p }));
  return {
    fetchProjects: async () => server.map((p) => ({ ...p })),
    addProject: async ({ id, title }) => {
      const existing = server.find((p) => p.id === id);
      if (existing) return { ...existing };
      const row = project(id, title);
      server.push(row);
      return { ...row };
    },
    setProjectStatus: async (id, status) => {
      const row = server.find((p) => p.id === id);
      if (!row) throw new Error(`no project ${id}`);
      row.status = status;
      if (status === "done") server.splice(server.indexOf(row), 1);
      return { ...row, status };
    },
    editProject: async (id, fields) => {
      const row = server.find((p) => p.id === id);
      if (!row) throw new Error(`no project ${id}`);
      Object.assign(row, fields);
      return { ...row };
    },
    deleteProject: async (id) => {
      const i = server.findIndex((p) => p.id === id);
      if (i >= 0) server.splice(i, 1);
    },
  };
}

function fakeTasksRest(initial: Task[]): TasksRest {
  const server = initial.map((t) => ({ ...t }));
  return {
    fetchTasks: async () => server.map((t) => ({ ...t })),
    addTask: async ({ id, text, showUpDate, projectId, takenOnAt }) => {
      const row: Task = {
        id,
        text,
        showUpDate,
        createdAt: new Date().toISOString(),
        completedAt: null,
        projectId,
        takenOnAt,
      };
      server.push(row);
      return { ...row };
    },
    completeTask: async (id) => {
      const row = server.find((t) => t.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.completedAt = new Date().toISOString();
      return { ...row };
    },
    setTaskTakenOn: async (id, takenOnAt) => {
      const row = server.find((t) => t.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.takenOnAt = takenOnAt;
      return { ...row };
    },
  };
}

function setApi(initial: Project[], tasks: Task[] = []) {
  h.api = createInMemoryProjectsApi({
    queryClient: new QueryClient(),
    rest: fakeRest(initial),
  });
  h.tasksApi = createInMemoryTasksApi({
    queryClient: new QueryClient(),
    rest: fakeTasksRest(tasks),
  });
  h.waitsApi = createInMemoryWaitsApi({
    queryClient: new QueryClient(),
    rest: fakeWaitsRest(),
  });
  h.capturesApi = createInMemoryApi({
    queryClient: new QueryClient(),
    rest: {
      fetchCaptures: async () => [],
      addCapture: async ({ id, text }) => ({
        id,
        text,
        createdAt: new Date().toISOString(),
        processedAt: null,
        showUpDate: null,
        sortKey: null,
      }),
      processCapture: async (id) => {
        throw new Error(`no capture ${id}`);
      },
      editCapture: async (id) => {
        throw new Error(`no capture ${id}`);
      },
      rescheduleCapture: async (id) => {
        throw new Error(`no capture ${id}`);
      },
      reorderCapture: async (id) => {
        throw new Error(`no capture ${id}`);
      },
    },
  });
}

describe("ProjectsPage", () => {
  afterEach(() => {
    h.api = null;
    h.tasksApi = null;
    h.waitsApi = null;
    h.capturesApi = null;
    vi.useRealTimers();
  });

  it("adds a free-text waiting condition, marking the project Waiting", async () => {
    setApi([project("1", "Send tax letter", "next")]);
    render(<ProjectsPage />);
    fireEvent.click(await screen.findByText("Send tax letter"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Waiting condition" }),
      { target: { value: "the letter comes back" } },
    );
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "+ Waiting condition" }),
      );
    });
    // The project moves to the Waiting section.
    await waitFor(() => expect(screen.getByText("Waiting")).toBeInTheDocument());
  });

  it("adds a task to a project from its detail sheet", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    render(<ProjectsPage />);
    fireEvent.click(await screen.findByText("Run a 5K"));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox", {
      name: "Add a task to this project",
    });
    fireEvent.change(input, { target: { value: "buy running shoes" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Complete "buy running shoes"' }),
      ).toBeInTheDocument(),
    );
  });

  it("shows the fetched projects with their icons", async () => {
    setApi([project("1", "Run a 5K", "next", "🏃")]);
    render(<ProjectsPage />);
    expect(await screen.findByText("Run a 5K")).toBeInTheDocument();
    expect(screen.getByText("🏃")).toBeInTheDocument();
  });

  it("moves a project to backlog from the detail sheet", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    render(<ProjectsPage />);
    fireEvent.click(await screen.findByText("Run a 5K"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move to backlog" }));
    });
    // Moved to Backlog: the Backlog section header appears.
    await waitFor(() => expect(screen.getByText("Backlog")).toBeInTheDocument());
  });

  it("shows a project as Active once one of its tasks is taken on", async () => {
    // A 'next' project with a taken-on open task derives to Active.
    setApi(
      [project("1", "Run a 5K", "next")],
      [
        {
          id: "t1",
          text: "buy shoes",
          showUpDate: "2023-01-01",
          createdAt: "2023-01-01T00:00:00.000Z",
          completedAt: null,
          projectId: "1",
          takenOnAt: "2023-01-02T00:00:00.000Z",
        },
      ],
    );
    render(<ProjectsPage />);
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
  });

  it("defers Delete behind an Undo and does not commit when undone", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    render(<ProjectsPage />);
    fireEvent.click(await screen.findByText("Run a 5K"));
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

    // The row is held with an Undo; nothing is deleted yet.
    const undo = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undo);

    // Undone: the row is tappable again and no Undo remains.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(),
    );
    expect(screen.getByText("Run a 5K")).toBeInTheDocument();
  });

  it("commits Delete after the undo window elapses", async () => {
    vi.useFakeTimers();
    setApi([project("1", "Run a 5K", "next")]);
    render(<ProjectsPage />);
    // Flush the async getProjectsApi + first fetch under fake timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByText("Run a 5K"));
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    // The row is gone after the window commits the hard delete.
    expect(screen.queryByText("Run a 5K")).toBeNull();
  });
});
