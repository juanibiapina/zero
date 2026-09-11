import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { QueryClient } from "@tanstack/react-query";
import {
  createInMemoryProjectsApi,
  createInMemoryTasksApi,
  createInMemoryWaitsApi,
  type Project,
  type ProjectsApi,
  type ProjectsRest,
  type Task,
  type TasksApi,
  type TasksRest,
  type WaitsApi,
  type WaitsRest,
  defaultToastController,
} from "@zero/agent-core";

import { HomePage } from "./HomePage";

// Give the real page fresh in-memory collections per test. The array-backed
// REST boundary keeps each interaction deterministic without OPFS or network.
const h = vi.hoisted(() => ({
  tasksApi: null as TasksApi | null,
  projectsApi: null as ProjectsApi | null,
  waitsApi: null as WaitsApi | null,
}));
vi.mock("@/lib/tasks-collection", () => ({
  getTasksApi: () => Promise.resolve(h.tasksApi),
}));
vi.mock("@/lib/projects-collection", () => ({
  getProjectsApi: () => Promise.resolve(h.projectsApi),
}));
vi.mock("@/lib/waits-collection", () => ({
  getWaitsApi: () => Promise.resolve(h.waitsApi),
}));

const emptyWaitsRest: WaitsRest = {
  fetchWaits: async () => [],
  addWaitingCondition: async (c) => ({
    ...c,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
  }),
  resolveWaitingCondition: async (id) => {
    throw new Error(`no condition ${id}`);
  },
  deleteWaitingCondition: async () => {},
};

const emptyProjectsRest: ProjectsRest = {
  fetchProjects: async () => [],
  addProject: async ({ id, title }) => ({
    id,
    title,
    icon: "📁",
    description: null,
    status: "next",
    createdAt: new Date().toISOString(),
  }),
  setProjectStatus: async (id) => {
    throw new Error(`no project ${id}`);
  },
  editProject: async (id) => {
    throw new Error(`no project ${id}`);
  },
  deleteProject: async () => {},
};

// A loose task with no show-up date (always shown up on Home).
const taskRow = (id: string, text: string, over: Partial<Task> = {}): Task => ({
  id,
  text,
  showUpDate: over.showUpDate === undefined ? null : over.showUpDate,
  createdAt: over.createdAt ?? `2023-01-0${id}T00:00:00.000Z`,
  completedAt: over.completedAt ?? null,
  projectId: over.projectId ?? null,
  takenOnAt: over.takenOnAt ?? null,
  sortKey: over.sortKey ?? null,
});

// Records reschedule calls so tests can assert the scheduler wiring.
const rescheduled: { id: string; showUpDate: string | null }[] = [];

// Records move-to-project calls so tests can assert the project-picker wiring.
const moved: { id: string; projectId: string | null }[] = [];

function fakeTasksRest(initial: Task[]): TasksRest {
  const server = initial.map((item) => ({ ...item }));
  return {
    fetchTasks: async () =>
      server.filter((t) => t.completedAt == null).map((item) => ({ ...item })),
    addTask: async ({ id, text, showUpDate, projectId, takenOnAt }) => {
      const row: Task = {
        id,
        text,
        showUpDate,
        createdAt: new Date().toISOString(),
        completedAt: null,
        projectId,
        takenOnAt,
        sortKey: `a${server.length}`,
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
    reopenTask: async (id) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.completedAt = null;
      return { ...row };
    },
    setTaskTakenOn: async (id, takenOnAt) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.takenOnAt = takenOnAt;
      return { ...row };
    },
    editTask: async (id, text) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.text = text;
      return { ...row };
    },
    rescheduleTask: async (id, showUpDate) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.showUpDate = showUpDate;
      rescheduled.push({ id, showUpDate });
      return { ...row };
    },
    reorderTask: async (id, sortKey) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.sortKey = sortKey;
      return { ...row };
    },
    setTaskProject: async (id, projectId) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.projectId = projectId;
      if (projectId != null) row.takenOnAt = null;
      moved.push({ id, projectId });
      return { ...row };
    },
  };
}

function fakeProjectsRest(initial: Project[]): ProjectsRest {
  const server = initial.map((item) => ({ ...item }));
  return {
    ...emptyProjectsRest,
    fetchProjects: async () => server.map((item) => ({ ...item })),
  };
}

const projectRow = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  title: over.title ?? id,
  icon: over.icon ?? "📁",
  description: over.description ?? null,
  status: over.status ?? "next",
  createdAt: over.createdAt ?? "2023-01-01T00:00:00.000Z",
});

function setApi(tasks: Task[] = [], projects: Project[] = []) {
  rescheduled.length = 0;
  moved.length = 0;
  h.tasksApi = createInMemoryTasksApi({
    queryClient: new QueryClient(),
    rest: fakeTasksRest(tasks),
  });
  h.projectsApi = createInMemoryProjectsApi({
    queryClient: new QueryClient(),
    rest: fakeProjectsRest(projects),
  });
  h.waitsApi = createInMemoryWaitsApi({
    queryClient: new QueryClient(),
    rest: emptyWaitsRest,
  });
}

describe("HomePage", () => {
  afterEach(() => {
    h.tasksApi = null;
    h.projectsApi = null;
    h.waitsApi = null;
    defaultToastController.dismiss();
  });

  it("titles the screen Home", async () => {
    setApi();
    render(<HomePage />, { wrapper: MemoryRouter });
    expect(
      await screen.findByRole("heading", { name: "Home", level: 1 }),
    ).toBeInTheDocument();
  });

  it("shows the plan CTA when the list is empty and a project is next", async () => {
    setApi([], [projectRow("p", { status: "next" })]);
    render(<HomePage />, { wrapper: MemoryRouter });

    const cta = await screen.findByRole("link", { name: "Plan your day" });
    expect(cta).toHaveAttribute("href", "/projects");
    expect(screen.getByText("1 Next")).toBeInTheDocument();
  });

  it("shows the create CTA when there are no projects and no tasks", async () => {
    setApi();
    render(<HomePage />, { wrapper: MemoryRouter });

    expect(
      await screen.findByRole("link", { name: "Create your first project" }),
    ).toHaveAttribute("href", "/projects");
  });

  it("renders a loose task and no CTA", async () => {
    setApi([taskRow("1", "buy milk")], [projectRow("p", { status: "next" })]);
    render(<HomePage />, { wrapper: MemoryRouter });

    expect(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Plan your day" })).toBeNull();
  });

  it("badges a project task with its project icon", async () => {
    setApi(
      [
        taskRow("1", "mail the letter", {
          projectId: "p",
          takenOnAt: "2023-01-02T00:00:00.000Z",
        }),
      ],
      [projectRow("p", { status: "next", icon: "🎓" })],
    );
    render(<HomePage />, { wrapper: MemoryRouter });

    await screen.findByRole("button", { name: 'Complete "mail the letter"' });
    expect(screen.getByText("🎓")).toBeInTheDocument();
  });

  it("adds a loose task from the default Task quick-add", async () => {
    setApi();
    render(<HomePage />, { wrapper: MemoryRouter });

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Add a task" }),
      { target: { value: "call the dentist" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Edit "call the dentist"' }),
      ).toBeInTheDocument(),
    );
  });

  it("creates a project from the Project mode, stays on Home, and toasts a link to it", async () => {
    setApi();
    let path = "";
    function Probe() {
      path = useLocation().pathname;
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <HomePage />
        <Probe />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("radio", { name: "Project" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Name an outcome" }),
      { target: { value: "ship the app" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    await waitFor(() =>
      expect(defaultToastController.getSnapshot()).toHaveLength(1),
    );
    expect(path).toBe("/");
    const [t] = defaultToastController.getSnapshot();
    expect(t.message).toBe("Project created");
    expect(t.description).toBe("ship the app");
    expect(t.action?.label).toBe("View");

    await act(async () => {
      t.action?.onPress();
    });
    await waitFor(() => expect(path).toMatch(/^\/projects\/.+/));
  });

  it("completes a task, leaves it at once, and offers Undo that reopens it", async () => {
    setApi([taskRow("1", "mail the letter")]);
    render(<HomePage />, { wrapper: MemoryRouter });

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

    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe("Completed");
    expect(snap[0].action?.label).toBe("Undo");
    await act(async () => {
      snap[0].action?.onPress();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Complete "mail the letter"' }),
      ).toBeInTheDocument(),
    );
  });

  it("edits a task from its detail sheet", async () => {
    setApi([taskRow("1", "buy milk")]);
    render(<HomePage />, { wrapper: MemoryRouter });

    fireEvent.click(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    );
    const input = screen.getByRole("textbox", { name: "Task text" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "buy oat milk" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Edit "buy oat milk"' }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("preserves the stored text when the sheet draft is empty", async () => {
    setApi([taskRow("1", "buy milk")]);
    render(<HomePage />, { wrapper: MemoryRouter });

    fireEvent.click(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    );
    const input = screen.getByRole("textbox", { name: "Task text" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: 'Edit "buy milk"' }),
    ).toBeInTheDocument();
  });

  it("completes a task from its detail sheet via the circle", async () => {
    setApi([taskRow("1", "buy milk")]);
    render(<HomePage />, { wrapper: MemoryRouter });

    fireEvent.click(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Complete task" }));
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: 'Edit "buy milk"' }),
      ).toBeNull(),
    );
  });

  it("schedules a task to tomorrow from the detail sheet", async () => {
    setApi([taskRow("1", "buy milk")]);
    render(<HomePage />, { wrapper: MemoryRouter });

    fireEvent.click(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Tomorrow/ }));
    });

    await waitFor(() => expect(rescheduled.length).toBe(1));
    expect(rescheduled[0].id).toBe("1");
    expect(rescheduled[0].showUpDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("postpones a task to tomorrow from the row button", async () => {
    setApi([taskRow("1", "buy milk")]);
    render(<HomePage />, { wrapper: MemoryRouter });

    const btn = await screen.findByRole("button", {
      name: 'Postpone "buy milk" to tomorrow',
    });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => expect(rescheduled.length).toBe(1));
    expect(rescheduled[0].id).toBe("1");
  });

  it("moves a loose task into a project from the detail sheet", async () => {
    setApi(
      [taskRow("1", "buy milk")],
      [projectRow("p", { title: "Groceries", status: "next" })],
    );
    render(<HomePage />, { wrapper: MemoryRouter });

    fireEvent.click(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    );
    // The project row reads "Project" when the task is loose; open the picker.
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Groceries" }));
    });

    await waitFor(() => expect(moved.length).toBe(1));
    expect(moved[0]).toEqual({ id: "1", projectId: "p" });
  });
});
