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
  createInMemoryProjectsApi,
  createInMemoryTasksApi,
  type Project,
  type ProjectsApi,
  type ProjectsRest,
  type ProjectStatus,
  type Task,
  type TasksApi,
  type TasksRest,
} from "@zero/agent-core";

import { ProjectsPage } from "./ProjectsPage";

// The page reads its data layers through getProjectsApi() / getTasksApi(); hand
// each a fresh in-memory collection per test (backed by an array "server"), so
// the real ProjectsPage, the shared collections, and the undoable-leave hook are
// all exercised without OPFS or the network.
const h = vi.hoisted(() => ({
  api: null as ProjectsApi | null,
  tasksApi: null as TasksApi | null,
}));
vi.mock("@/lib/projects-collection", () => ({
  getProjectsApi: () => Promise.resolve(h.api),
}));
vi.mock("@/lib/tasks-collection", () => ({
  getTasksApi: () => Promise.resolve(h.tasksApi),
}));

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
    addTask: async ({ id, text, showUpDate, projectId }) => {
      const row: Task = {
        id,
        text,
        showUpDate,
        createdAt: new Date().toISOString(),
        completedAt: null,
        projectId,
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
}

describe("ProjectsPage", () => {
  afterEach(() => {
    h.api = null;
    h.tasksApi = null;
    vi.useRealTimers();
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

  it("changes a project status from the detail sheet", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    render(<ProjectsPage />);
    fireEvent.click(await screen.findByText("Run a 5K"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Active" }));
    });
    // Moved to Active: the section header for Active now shows a count.
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
