import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  createInMemoryProjectsApi,
  createInMemoryTasksApi,
  createInMemoryWaitsApi,
  defaultToastController,
  type Project,
  type ProjectsApi,
  type ProjectsRest,
  type ProjectState,
  type Task,
  type TasksApi,
  type TasksRest,
  type WaitingCondition,
  type WaitsApi,
  type WaitsRest,
} from "@zero/agent-core";

import { ProjectsPage } from "./ProjectsPage";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { __resetIconSuggestions } from "@/lib/icon-suggestions";

// The pages read their data layers through getProjectsApi() / getTasksApi(); hand
// each a fresh in-memory collection per test (backed by an array "server"), so
// the real pages, the shared collections, and the undoable-leave hook are all
// exercised without OPFS or the network. The list and the detail page share the
// same singleton collections, so navigating between them reads one source.
const h = vi.hoisted(() => ({
  api: null as ProjectsApi | null,
  tasksApi: null as TasksApi | null,
  waitsApi: null as WaitsApi | null,
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

function fakeWaitsRest(initial: WaitingCondition[] = []): WaitsRest {
  const server: WaitingCondition[] = initial.map((c) => ({ ...c }));
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
  state: ProjectState | "next" = "in-play",
  icon = "📁",
): Project => ({
  id,
  title,
  icon,
  description: null,
  state: state === "next" ? "in-play" : state,
  createdAt: `2023-01-0${id.slice(-1)}T00:00:00.000Z`,
});

const task = (id: string, text: string, projectId: string): Task => ({
  id,
  text,
  showUpDate: "2023-01-01",
  createdAt: "2023-01-01T00:00:00.000Z",
  completedAt: null,
  projectId,
  sortKey: null,
});

function fakeRest(initial: Project[]): ProjectsRest {
  const server = initial.map((p) => ({ ...p }));
  return {
    fetchProjects: async () =>
      server.filter((item) => item.state !== "done").map((item) => ({ ...item })),
    addProject: async ({ id, title }) => {
      const existing = server.find((p) => p.id === id);
      if (existing) return { ...existing };
      const row = project(id, title);
      server.push(row);
      return { ...row };
    },
    setProjectState: async (id, state) => {
      const row = server.find((p) => p.id === id);
      if (!row) throw new Error(`no project ${id}`);
      row.state = state;
      return { ...row, state };
    },
    reopenProject: async (id, state) => {
      const row = server.find((item) => item.id === id);
      if (!row) throw new Error(`no project ${id}`);
      row.state = state;
      return { ...row };
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
        sortKey: `a${server.length}`,
      };
      server.push(row);
      return { ...row };
    },
    editTask: async (id, text) => {
      const row = server.find((t) => t.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.text = text;
      return { ...row };
    },
    rescheduleTask: async (id, showUpDate) => {
      const row = server.find((t) => t.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.showUpDate = showUpDate;
      return { ...row };
    },
    reorderTask: async (id, sortKey) => {
      const row = server.find((t) => t.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.sortKey = sortKey;
      return { ...row };
    },
    setTaskProject: async (id, projectId) => {
      const row = server.find((t) => t.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.projectId = projectId;
      return { ...row };
    },
    completeTask: async (id) => {
      const row = server.find((t) => t.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.completedAt = new Date().toISOString();
      return { ...row };
    },
    reopenTask: async (id) => {
      const row = server.find((t) => t.id === id);
      if (!row) throw new Error(`no task ${id}`);
      row.completedAt = null;
      return { ...row };
    },
  };
}

const dependencyCondition = (
  id: string,
  projectId: string,
  refId: string,
  createdAt = "2023-01-01T00:00:00.000Z",
): WaitingCondition => ({
  id,
  projectId,
  kind: "project-status",
  text: null,
  refId,
  targetStatus: "done",
  resolvedAt: null,
  createdAt,
});

const waitCondition = (
  id: string,
  projectId: string,
  createdAt: string,
): WaitingCondition => ({
  id,
  projectId,
  kind: "free-text",
  text: "a reply",
  refId: null,
  targetStatus: null,
  resolvedAt: null,
  createdAt,
});

function setApi(
  initial: Project[],
  tasks: Task[] = [],
  waits: WaitingCondition[] = [],
) {
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
    rest: fakeWaitsRest(waits),
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
  let row = screen.queryByText(title);
  if (!row) {
    const after = screen.queryByRole("button", { name: /^After/ });
    if (after) {
      fireEvent.click(after);
      await waitFor(() => expect(after).toHaveAttribute("aria-expanded", "true"));
    }
    row = await screen.findByText(title);
  }
  fireEvent.click(row);
  await screen.findByRole("textbox", { name: "Project title" });
}

describe("ProjectsPage", () => {
  afterEach(() => {
    h.api = null;
    h.tasksApi = null;
    h.waitsApi = null;
    defaultToastController.dismiss();
    vi.useRealTimers();
  });

  it("shows the fetched projects with their icons", async () => {
    setApi([project("1", "Run a 5K", "next", "🏃")]);
    renderApp();
    expect(await screen.findByText("Run a 5K")).toBeInTheDocument();
    expect(screen.getByText("🏃")).toBeInTheDocument();
  });

  it("badges each waiting project with how long it has waited, longest-first", async () => {
    // Both projects are 'next' with an open condition and no tasks, so both
    // derive to waiting. "Older" has the earlier condition, so it has waited
    // longer and must sort above "Newer".
    setApi(
      [
        project("1", "Newer wait", "next"),
        project("2", "Older wait", "next"),
      ],
      [],
      [
        waitCondition("cA", "1", "2024-06-01T00:00:00.000Z"),
        waitCondition("cB", "2", "2023-01-01T00:00:00.000Z"),
      ],
    );
    renderApp();

    // Both rows carry a "Waiting …" badge.
    await screen.findByText("Older wait");
    const badges = screen.getAllByLabelText(/^Waiting /);
    expect(badges).toHaveLength(2);

    // Longest wait on top: "Older wait" precedes "Newer wait" in the document.
    const older = screen.getByText("Older wait");
    const newer = screen.getByText("Newer wait");
    expect(
      older.compareDocumentPosition(newer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("badges a project waiting only on a future-dated task with its day, and shows it on the detail screen", async () => {
    // A 'next' project whose sole task is dated in the far future derives to
    // waiting-until — no stored condition. The list badge and the detail
    // Waiting-on row both read the target day.
    setApi(
      [project("1", "Trip planning", "next")],
      [
        {
          ...task("t1", "book flights", "1"),
          showUpDate: "2099-12-31",
        },
      ],
    );
    renderApp();
    await screen.findByText("Trip planning");
    // The Projects list badges it "until <day>" (aria "Waiting until …").
    expect(screen.getByLabelText(/^Waiting until /)).toBeInTheDocument();

    await openDetail("Trip planning");
    expect(screen.getByText(/^Waiting · until /)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Waiting on" })).toBeNull();
    expect(screen.queryByText("auto")).toBeNull();
  });

  it("shows After after Waiting, collapsed by default, with compact context", async () => {
    setApi(
      [
        project("1", "After project"),
        project("2", "Prerequisite", "next", "🏠"),
        project("3", "Waiting project"),
      ],
      [],
      [
        dependencyCondition("dependency", "1", "2"),
        waitCondition("wait", "3", "2023-01-01T00:00:00.000Z"),
      ],
    );
    renderApp();

    const after = await screen.findByRole("button", { name: /^After/ });
    expect(after).toHaveAttribute("aria-expanded", "false");
    const waiting = screen.getByRole("button", { name: /^Waiting·/ });
    expect(
      waiting.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(after);
    expect(screen.getByText("after 🏠 Prerequisite")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Add to Run a 5K" }));
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    const input = screen.getByRole("textbox", { name: "Add task" });
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

  it("completes a task from the detail screen and offers Undo that reopens it", async () => {
    setApi([project("1", "Run a 5K", "next")], [task("t1", "buy running shoes", "1")]);
    renderApp();
    await openDetail("Run a 5K");
    const complete = await screen.findByRole("button", {
      name: 'Complete "buy running shoes"',
    });

    await act(async () => {
      fireEvent.click(complete);
    });
    // The row leaves immediately.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: 'Complete "buy running shoes"' }),
      ).toBeNull(),
    );

    // A single Undo toast is offered; tapping it reopens the task, restoring the row.
    const snap = defaultToastController.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe("Completed");
    expect(snap[0].description).toBe("📁 Run a 5K");
    expect(snap[0].secondaryAction?.label).toBe("Waiting for…");
    expect(snap[0].action?.label).toBe("Undo");
    await act(async () => snap[0].secondaryAction?.onPress());
    expect(screen.getByRole("textbox", { name: "Waiting condition" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {
      snap[0].action?.onPress();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Complete "buy running shoes"' }),
      ).toBeInTheDocument(),
    );
  });

  it("shows an After relationship separately and navigates to its target", async () => {
    setApi(
      [
        project("1", "Move house"),
        project("2", "Sell old house", "next", "🏠"),
      ],
      [],
      [dependencyCondition("dependency", "1", "2")],
    );
    renderApp(["/projects/1"]);
    await screen.findByRole("textbox", { name: "Project title" });

    expect(screen.getByText("After · 🏠 Sell old house")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "After" })).toBeInTheDocument();
    expect(screen.queryByText("Must be completed first")).toBeNull();
    expect(screen.queryByText("auto")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open project Sell old house" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Project title" })).toHaveValue(
        "Sell old house",
      ),
    );
  });

  it("removes only the selected After relationship and recalculates the Project", async () => {
    setApi(
      [project("1", "Move house"), project("2", "Sell old house")],
      [],
      [dependencyCondition("dependency", "1", "2")],
    );
    renderApp(["/projects/1"]);
    await screen.findByRole("textbox", { name: "Project title" });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Remove After relationship with Sell old house",
        }),
      );
    });

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "After" })).toBeNull(),
    );
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.queryByText("Waiting on")).toBeNull();
  });

  it("adds a free-text waiting condition from the detail screen", async () => {
    setApi([project("1", "Send tax letter", "next")]);
    renderApp();
    await openDetail("Send tax letter");
    fireEvent.click(screen.getByRole("button", { name: "Add to Send tax letter" }));
    fireEvent.click(screen.getByRole("button", { name: "Waiting condition" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Add waiting condition" }),
      { target: { value: "the letter comes back" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    await waitFor(() =>
      expect(screen.getByText("the letter comes back")).toBeInTheDocument(),
    );
  });

  it("adds an After relationship through a searchable Project-only picker", async () => {
    setApi([
      project("1", "Move house"),
      project("2", "Sell old house", "next", "🏠"),
    ]);
    renderApp();
    await openDetail("Move house");
    fireEvent.click(screen.getByRole("button", { name: "Add to Move house" }));
    fireEvent.click(screen.getByRole("button", { name: "After project" }));
    expect(screen.queryByLabelText("Condition kind")).toBeNull();
    expect(screen.queryByLabelText("Target status")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter After projects"), {
      target: { value: "Sell" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Sell old house/ }));
    });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "After" })).toBeInTheDocument(),
    );
    expect(screen.getByText("Sell old house")).toBeInTheDocument();
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

  it("shows a project as Active once one of its tasks has an arrived date", async () => {
    // A 'next' project with a shown-up dated open task derives to Active.
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
          sortKey: null,
        },
      ],
    );
    renderApp();
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
  });

  it("marks a Project done immediately and offers Undo", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openDetail("Run a 5K");
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Mark done" }));
    });
    await screen.findByRole("heading", { name: "Projects" });
    await waitFor(() =>
      expect(screen.queryByText("Run a 5K")).not.toBeInTheDocument(),
    );
    const toast = defaultToastController.getSnapshot()[0];
    expect(toast?.message).toBe("Project completed");
    expect(toast?.action?.label).toBe("Undo");
    await act(async () => toast?.action?.onPress());
    expect(await screen.findByText("Run a 5K")).toBeInTheDocument();
  });

  it("deletes a project from detail and it leaves the list immediately", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openDetail("Run a 5K");
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete project" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    await screen.findByRole("heading", { name: "Projects" });
    await waitFor(() =>
      expect(screen.queryByText("Run a 5K")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("warns when deleting an After target may move another Project", async () => {
    setApi(
      [project("1", "Sell old house"), project("2", "Move house")],
      [],
      [dependencyCondition("dependency", "2", "1")],
    );
    renderApp();
    await openDetail("Sell old house");
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete project" }));

    expect(
      screen.getByText(/“Move house” is after it and may move to another section/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "Project title" })).toHaveValue(
      "Sell old house",
    );
  });

  it("re-pulls tasks and waits after a delete so cascaded orphans disappear", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    // The server cascades the delete to the project's tasks/conditions; the
    // screen re-pulls both dependent collections once the delete persists so
    // any lingering orphan (e.g. a future-dated task in Upcoming) drops.
    const tasksRefetch = vi.spyOn(h.tasksApi!, "refetch");
    const waitsRefetch = vi.spyOn(h.waitsApi!, "refetch");
    renderApp();
    await openDetail("Run a 5K");
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete project" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(tasksRefetch).toHaveBeenCalled());
    await waitFor(() => expect(waitsRefetch).toHaveBeenCalled());
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

// The AI icon-suggestion feature: a pre-warmed shortcut above the manual picker.
// The suggestion endpoint is a same-origin fetch, mocked here; the per-device
// cache is a module singleton, reset between tests.
describe("project icon suggestions", () => {
  const fetchMock = vi.fn();

  const respondIcons = (icons: string[]) =>
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ icons }),
    });

  const suggestionCalls = () =>
    fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/api/projects/icon-suggestions",
    );

  const openIconPicker = async (title: string) => {
    await openDetail(title);
    fireEvent.click(screen.getByRole("button", { name: "Change icon" }));
  };

  afterEach(() => {
    h.api = null;
    h.tasksApi = null;
    h.waitsApi = null;
    __resetIconSuggestions();
    fetchMock.mockReset();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    respondIcons(["🌟", "🚀"]);
  });

  it("pre-warms suggestions when a project is created", async () => {
    setApi([]);
    renderApp();
    fireEvent.change(await screen.findByRole("textbox", { name: "New project" }), {
      target: { value: "Run a 5K" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    await waitFor(() => expect(suggestionCalls().length).toBe(1));
    const [, init] = suggestionCalls()[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      title: "Run a 5K",
      description: null,
    });
  });

  it("fetches on open when the cache is empty and shows chips", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openIconPicker("Run a 5K");
    // The fetch-on-open fallback fires because nothing warmed this project.
    await waitFor(() => expect(suggestionCalls().length).toBe(1));
    expect(
      await screen.findByRole("button", { name: "Use suggested icon 🌟" }),
    ).toBeInTheDocument();
  });

  it("applies a tapped suggestion through the edit path", async () => {
    setApi([project("1", "Run a 5K", "next", "🏃")]);
    renderApp();
    await openIconPicker("Run a 5K");
    const chip = await screen.findByRole("button", {
      name: "Use suggested icon 🚀",
    });
    await act(async () => {
      fireEvent.click(chip);
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Change icon" }),
      ).toHaveTextContent("🚀"),
    );
  });

  it("shows a loading state while the request is in flight", async () => {
    let resolve!: (v: { icons: string[] }) => void;
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise<{ icons: string[] }>((r) => {
            resolve = r;
          }),
      } as unknown as Response),
    );
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openIconPicker("Run a 5K");
    expect(
      await screen.findByText("Loading suggested icons…"),
    ).toBeInTheDocument();
    await act(async () => {
      resolve({ icons: ["🌟"] });
    });
    expect(
      await screen.findByRole("button", { name: "Use suggested icon 🌟" }),
    ).toBeInTheDocument();
  });

  it("refreshes suggestions on demand", async () => {
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openIconPicker("Run a 5K");
    await screen.findByRole("button", { name: "Use suggested icon 🌟" });
    expect(suggestionCalls().length).toBe(1);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh suggested icons" }),
      );
    });
    await waitFor(() => expect(suggestionCalls().length).toBe(2));
  });

  it("keeps the manual picker usable when suggestions fail", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    setApi([project("1", "Run a 5K", "next")]);
    renderApp();
    await openIconPicker("Run a 5K");
    // The soft-failure line appears and the full manual picker is still present.
    expect(
      await screen.findByText("Couldn't load suggestions"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set icon 🎓" }),
    ).toBeInTheDocument();
  });
});
