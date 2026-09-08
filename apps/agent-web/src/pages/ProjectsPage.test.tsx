import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
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
import { ProjectDetailPage } from "./ProjectDetailPage";

// The pages read their data layers through getProjectsApi() / getTasksApi(); hand
// each a fresh in-memory collection per test (backed by an array "server"), so
// the real pages, the shared collections, and the undoable-leave hook are all
// exercised without OPFS or the network. The list and the detail page share the
// same singleton collections, so navigating between them reads one source.
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

// frimousse fetches its emoji data from a CDN at runtime, which never resolves
// in jsdom. Substitute a minimal picker whose Root exposes one selectable emoji
// so the icon-pick flow is exercised without the network (the real searchable
// grid is verified in the browser).
vi.mock("frimousse", () => {
  const Root = ({
    onEmojiSelect,
    children,
  }: {
    onEmojiSelect?: (emoji: { emoji: string; label: string }) => void;
    children?: ReactNode;
  }) => (
    <div>
      <button
        type="button"
        aria-label="Set icon 🎓"
        onClick={() => onEmojiSelect?.({ emoji: "🎓", label: "graduation cap" })}
      >
        🎓
      </button>
      {children}
    </div>
  );
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Noop = () => null;
  return {
    EmojiPicker: {
      Root,
      Search: Noop,
      Viewport: Passthrough,
      Loading: Noop,
      Empty: Noop,
      List: Noop,
    },
  };
});

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

// Render the projects list + detail routes together so a row tap really
// navigates to /projects/:id and a Done/Delete really hands back to the list.
function renderApp(entries: string[] = ["/projects"]) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// Open a project's detail screen by clicking its list row.
async function openDetail(title: string) {
  fireEvent.click(await screen.findByText(title));
  // The detail screen owns the task composer; wait for it to render.
  await screen.findByRole("textbox", { name: "Add a task to this project" });
}

describe("ProjectsPage", () => {
  afterEach(() => {
    h.api = null;
    h.tasksApi = null;
    h.waitsApi = null;
    h.capturesApi = null;
    vi.useRealTimers();
  });

  it("shows the fetched projects with their icons", async () => {
    setApi([project("1", "Run a 5K", "next", "🏃")]);
    renderApp();
    expect(await screen.findByText("Run a 5K")).toBeInTheDocument();
    expect(screen.getByText("🏃")).toBeInTheDocument();
  });

  it("navigates from a list row to the project's own screen", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openDetail("Run a 5K");
    // The editable title heading is a detail-only affordance.
    expect(
      screen.getByRole("textbox", { name: "Project title" }),
    ).toHaveValue("Run a 5K");
  });

  it("adds a task to a project from its detail screen", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openDetail("Run a 5K");
    const input = screen.getByRole("textbox", {
      name: "Add a task to this project",
    });
    fireEvent.change(input, { target: { value: "buy running shoes" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Complete "buy running shoes"' }),
      ).toBeInTheDocument(),
    );
  });

  it("adds a free-text waiting condition from the detail screen", async () => {
    setApi([project("1", "Send tax letter", "next")]);
    renderApp();
    await openDetail("Send tax letter");
    // The builder is revealed only after '+ Waiting condition'.
    fireEvent.click(
      screen.getByRole("button", { name: "+ Waiting condition" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Waiting condition" }),
      { target: { value: "the letter comes back" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    });
    await waitFor(() =>
      expect(screen.getByText("the letter comes back")).toBeInTheDocument(),
    );
  });

  it("changes the project icon from the detail screen picker", async () => {
    setApi([project("1", "Run a 5K", "next", "🏃")]);
    renderApp();
    await openDetail("Run a 5K");
    // The picker is hidden until the icon is tapped (de-emphasized).
    expect(screen.queryByRole("button", { name: "Set icon 🎓" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change icon" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set icon 🎓" }));
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change icon" })).toHaveTextContent(
        "🎓",
      ),
    );
  });

  it("moves a project to backlog from the overflow menu", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openDetail("Run a 5K");
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to backlog" }));
    });
    // The derived-status pill in the header now reads Backlog.
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
    renderApp();
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
  });

  it("marks a project done from detail and holds it on the list with Undo", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openDetail("Run a 5K");
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Mark done" }));
    });
    // Back on the list, the row is held with an Undo; nothing committed yet.
    const undo = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undo);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(),
    );
    expect(screen.getByText("Run a 5K")).toBeInTheDocument();
  });

  it("deletes a project from detail, deferred behind an Undo on the list", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openDetail("Run a 5K");
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete project" }));
    });
    const undo = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undo);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(),
    );
    expect(screen.getByText("Run a 5K")).toBeInTheDocument();
  });

  it("commits Delete after the undo window elapses", async () => {
    vi.useFakeTimers();
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByText("Run a 5K"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete project" }));
    // Let the list remount and its leave effect arm the Undo timer before the
    // window elapses.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByText("Run a 5K")).toBeNull();
  });

  it("redirects to the list when the project id is unknown", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp(["/projects/nope"]);
    // After the collection loads without a match, it falls back to the list.
    expect(
      await screen.findByRole("heading", { name: "Projects" }),
    ).toBeInTheDocument();
  });
});
