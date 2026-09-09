import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { QueryClient } from "@tanstack/react-query";
import {
  createInMemoryApi,
  createInMemoryProjectsApi,
  createInMemoryTasksApi,
  createInMemoryWaitsApi,
  type Capture,
  type CapturesApi,
  type CapturesRest,
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
  api: null as CapturesApi | null,
  tasksApi: null as TasksApi | null,
  projectsApi: null as ProjectsApi | null,
  waitsApi: null as WaitsApi | null,
}));
vi.mock("@/lib/captures-collection", () => ({
  getCapturesApi: () => Promise.resolve(h.api),
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
    unprocessCapture: async (id) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no capture ${id}`);
      row.processedAt = null;
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
  projectId: null,
  takenOnAt: null,
});

function fakeTasksRest(initial: Task[]): TasksRest {
  const server = initial.map((item) => ({ ...item }));
  return {
    fetchTasks: async () => server.map((item) => ({ ...item })),
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

function setApi(initial: Capture[], tasks: Task[] = [], projects: Project[] = []) {
  h.api = createInMemoryApi({
    queryClient: new QueryClient(),
    rest: fakeRest(initial),
  });
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
    h.api = null;
    h.tasksApi = null;
    h.projectsApi = null;
    h.waitsApi = null;
    defaultToastController.dismiss();
  });

  it("titles the screen Home", async () => {
    setApi([]);
    render(<HomePage />, { wrapper: MemoryRouter });
    expect(
      await screen.findByRole("heading", { name: "Home", level: 1 }),
    ).toBeInTheDocument();
  });

  it("shows the plan CTA when plate and inbox are empty and a project is next", async () => {
    setApi([], [], [projectRow("p", { status: "next" })]);
    render(<HomePage />, { wrapper: MemoryRouter });

    const cta = await screen.findByRole("link", { name: "Plan your day" });
    expect(cta).toHaveAttribute("href", "/projects");
    expect(screen.getByText("1 Next")).toBeInTheDocument();
  });

  it("shows the create CTA when there are no projects", async () => {
    setApi([]);
    render(<HomePage />, { wrapper: MemoryRouter });

    expect(
      await screen.findByRole("link", { name: "Create your first project" }),
    ).toHaveAttribute("href", "/projects");
  });

  it("shows the inbox and no CTA when the plate is empty but captures exist", async () => {
    setApi([capture("1", "buy milk")], [], [projectRow("p", { status: "next" })]);
    render(<HomePage />, { wrapper: MemoryRouter });

    expect(
      await screen.findByRole("button", { name: 'Edit "buy milk"' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Plan your day" }),
    ).toBeNull();
  });

  it("hides the inbox section when there are tasks but no captures", async () => {
    setApi([], [taskRow("1", "mail the letter")]);
    render(<HomePage />, { wrapper: MemoryRouter });

    await screen.findByRole("button", { name: 'Complete "mail the letter"' });
    expect(screen.queryByText("Inbox")).toBeNull();
    expect(
      screen.queryByText("No captures yet. Capture something."),
    ).toBeNull();
  });

  it("badges a project task on the plate with its project icon", async () => {
    setApi(
      [],
      [
        {
          ...taskRow("1", "mail the letter"),
          projectId: "p",
          takenOnAt: "2023-01-02T00:00:00.000Z",
        },
      ],
      [projectRow("p", { status: "next", icon: "🎓" })],
    );
    render(<HomePage />, { wrapper: MemoryRouter });

    await screen.findByRole("button", { name: 'Complete "mail the letter"' });
    expect(screen.getByText("🎓")).toBeInTheDocument();
  });

  it("adds a task from the Task quick-add mode", async () => {
    setApi([]);
    render(<HomePage />, { wrapper: MemoryRouter });

    fireEvent.click(await screen.findByRole("radio", { name: "Task" }));
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

  it("creates a project from the Project mode, stays on Home, and toasts a link to it", async () => {
    setApi([]);
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
    // Stays on Home; the toast is the only way to jump to the project.
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

  it("completes a task from the top region", async () => {
    setApi([], [taskRow("1", "mail the letter")]);
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
  });

  it("completes a capture, leaves it at once, and offers Undo that returns it", async () => {
    setApi([capture("1", "buy milk")]);
    render(<HomePage />, { wrapper: MemoryRouter });

    const process = await screen.findByRole("button", {
      name: 'Process "buy milk"',
    });
    await act(async () => {
      fireEvent.click(process);
    });

    // The capture leaves the inbox immediately.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: 'Process "buy milk"' }),
      ).toBeNull(),
    );

    // A single Undo toast is offered; tapping it returns the capture.
    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe("Completed");
    expect(snap[0].action?.label).toBe("Undo");
    await act(async () => {
      snap[0].action?.onPress();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Process "buy milk"' }),
      ).toBeInTheDocument(),
    );
  });

  it("edits a capture from its detail sheet", async () => {
    setApi([capture("1", "buy milk")]);
    render(<HomePage />, { wrapper: MemoryRouter });

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
    render(<HomePage />, { wrapper: MemoryRouter });

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
    render(<HomePage />, { wrapper: MemoryRouter });

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
    render(<HomePage />, { wrapper: MemoryRouter });

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
