import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter as RouterMemoryRouter, Route, Routes } from "react-router";
import {
  defaultToastController,
  type Project,
  type ProjectState,
  type Task,
  type TaskdoReplica,
  type WaitingCondition,
} from "@zero/agent-core";

import { ProjectsPage } from "./ProjectsPage";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { __resetIconSuggestions } from "@/lib/icon-suggestions";
import { TodoDataContextProvider, type TodoData } from "@/lib/todo-data";
import { createInMemoryTodoData } from "@/testing/in-memory-todo-data";

// Give the real pages one fresh in-memory replica through their public data
// owner. The list and detail page therefore exercise one shared source.
const h = {
  replica: null as TaskdoReplica | null,
};

function MemoryRouter(props: ComponentProps<typeof RouterMemoryRouter>) {
  const value: TodoData = {
    replica: h.replica,
    ready: true,
    connected: true,
    sync: { phase: "synced", lastSyncedAt: null },
    durable: true,
    error: null,
    durabilityError: null,
    recoveries: [],
  };
  return <TodoDataContextProvider value={value}><RouterMemoryRouter {...props} /></TodoDataContextProvider>;
}

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
  recurrence: null,
  recurrenceDate: null,
  createdAt: "2023-01-01T00:00:00.000Z",
  completedAt: null,
  projectId,
  sortKey: null,
});

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
  const { data } = createInMemoryTodoData({ projects: initial, tasks, waits });
  h.replica = data.replica;
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
  let row = screen.queryByRole("button", { name: title });
  if (!row) {
    const after = screen.queryByRole("button", { name: /^After/ });
    if (after) {
      fireEvent.click(after);
      await waitFor(() => expect(after).toHaveAttribute("aria-expanded", "true"));
    }
    row = await screen.findByRole("button", { name: title });
  }
  fireEvent.click(row);
  await screen.findByRole("textbox", { name: "Project title" });
}

// jsdom has no layout; dnd-kit's real keyboard sensor needs measured row
// positions to choose the next drop target.
function measureTaskRows() {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (
        this.tagName === "LI" &&
        this.closest('[aria-labelledby="project-tasks-heading"]')
      ) {
        const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
        return new DOMRect(0, index * 60, 300, 50);
      }
      return new DOMRect(0, 0, 0, 0);
    });
}

async function moveWithKeyboard(
  text: string,
  direction: "ArrowUp" | "ArrowDown",
  steps = 1,
) {
  const handle = screen.getByRole("button", { name: `Reorder "${text}"` });
  handle.focus();
  await act(async () => {
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (let i = 0; i < steps; i++) {
    await act(async () => {
      fireEvent.keyDown(document, { key: direction, code: direction });
    });
  }
  await act(async () => {
    fireEvent.keyDown(document, { key: " ", code: "Space" });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ProjectsPage", () => {
  afterEach(() => {
    h.replica = null;
    defaultToastController.dismiss();
    vi.restoreAllMocks();
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

  it("folds a growing Backlog until its section is manually expanded", async () => {
    setApi([
      ...Array.from({ length: 5 }, (_, i) => project(String(i + 1), `Backlog ${i}`, "backlog")),
      project("6", "Another Project"),
    ]);
    renderApp();
    const backlog = await screen.findByRole("button", { name: /^Backlog·/ });
    expect(backlog).toHaveAttribute("aria-expanded", "true");
    await act(async () => { await h.replica!.projects.setState("6", "backlog").isPersisted.promise; });
    await waitFor(() => expect(backlog).toHaveAttribute("aria-expanded", "false"));
    fireEvent.click(backlog);
    expect(backlog).toHaveAttribute("aria-expanded", "true");
    await act(async () => { await h.replica!.projects.setState("6", "in-play").isPersisted.promise; });
    await act(async () => { await h.replica!.projects.setState("6", "backlog").isPersisted.promise; });
    expect(backlog).toHaveAttribute("aria-expanded", "true");
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
    const input = screen.getByRole("textbox", { name: "Add a task" });
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

  it("orders project tasks by their saved keys and moves one with the keyboard", async () => {
    setApi(
      [project("1", "Run a 5K"), project("2", "Read books")],
      [
        { ...task("a", "first", "1"), sortKey: "a1", createdAt: "2023-01-03T00:00:00.000Z", showUpDate: null },
        { ...task("other", "not this project", "2"), sortKey: "a2" },
        { ...task("b", "middle", "1"), sortKey: "a3", createdAt: "2023-01-01T00:00:00.000Z", showUpDate: "2099-12-31" },
        { ...task("c", "last", "1"), sortKey: "a5", createdAt: "2023-01-02T00:00:00.000Z" },
      ],
    );
    measureTaskRows();
    const reorder = vi.spyOn(h.replica!.tasks, "reorder");
    renderApp(["/projects/1"]);
    const region = await screen.findByRole("region", { name: "Tasks" });
    const order = () =>
      within(region).getAllByRole("button", { name: /^Complete / })
        .map((button) => button.getAttribute("aria-label"));
    expect(order()).toEqual([
      'Complete "first"',
      'Complete "middle"',
      'Complete "last"',
    ]);
    expect(within(region).queryByText("not this project")).toBeNull();

    await moveWithKeyboard("last", "ArrowUp");
    await waitFor(() => expect(order()).toEqual([
      'Complete "first"',
      'Complete "last"',
      'Complete "middle"',
    ]));
    expect(reorder).toHaveBeenCalledOnce();
    expect(reorder.mock.calls[0]?.[0]).toBe("c");
    const newKey = reorder.mock.calls[0]?.[1];
    expect(newKey).toBeDefined();
    expect(newKey > "a1" && newKey < "a3").toBe(true);

    expect(order()).toEqual([
      'Complete "first"',
      'Complete "last"',
      'Complete "middle"',
    ]);
    fireEvent.click(screen.getByRole("button", { name: "← Projects" }));
    await openDetail("Run a 5K");
    expect(order()).toEqual([
      'Complete "first"',
      'Complete "last"',
      'Complete "middle"',
    ]);
  });

  it("moves tasks to either end without writing on an unchanged drop", async () => {
    setApi([project("1", "Run a 5K")], [
      { ...task("a", "first", "1"), sortKey: "a1" },
      { ...task("b", "middle", "1"), sortKey: "a3" },
      { ...task("c", "last", "1"), sortKey: "a5" },
    ]);
    measureTaskRows();
    const reorder = vi.spyOn(h.replica!.tasks, "reorder");
    renderApp(["/projects/1"]);
    const region = await screen.findByRole("region", { name: "Tasks" });
    const order = () => within(region).getAllByRole("button", { name: /^Complete / })
      .map((button) => button.getAttribute("aria-label"));

    await moveWithKeyboard("last", "ArrowUp", 2);
    await waitFor(() => expect(order()[0]).toBe('Complete "last"'));
    expect(reorder.mock.calls[0]?.[1] < "a1").toBe(true);

    await moveWithKeyboard("last", "ArrowDown", 2);
    await waitFor(() => expect(order()[2]).toBe('Complete "last"'));
    expect(reorder.mock.calls[1]?.[1] > "a3").toBe(true);

    await moveWithKeyboard("last", "ArrowDown");
    expect(order()).toEqual([
      'Complete "first"', 'Complete "middle"', 'Complete "last"',
    ]);
    expect(reorder).toHaveBeenCalledTimes(2);
  });

  it("moves a project task using its pointer drag handle", async () => {
    setApi([project("1", "Run a 5K")], [
      { ...task("a", "first", "1"), sortKey: "a1" },
      { ...task("b", "second", "1"), sortKey: "a3" },
      { ...task("c", "third", "1"), sortKey: "a5" },
    ]);
    measureTaskRows();
    renderApp(["/projects/1"]);
    const region = await screen.findByRole("region", { name: "Tasks" });
    const handle = within(region).getByRole("button", { name: 'Reorder "third"' });
    await act(async () => {
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 20, clientY: 130, button: 0, isPrimary: true });
    });
    await act(async () => {
      fireEvent.pointerMove(document, { pointerId: 1, clientX: 20, clientY: 10, isPrimary: true });
    });
    await act(async () => {
      fireEvent.pointerUp(document, { pointerId: 1, clientX: 20, clientY: 10, isPrimary: true });
    });
    await waitFor(() => expect(
      within(region).getAllByRole("button", { name: /^Complete / })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(['Complete "third"', 'Complete "first"', 'Complete "second"']));
    // dnd-kit keeps a document click guard for 50 ms after a pointer drop.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  });

  it("keeps the date control usable after an offline-capable reorder", async () => {
    setApi([project("1", "Run a 5K")], [
      { ...task("a", "first", "1"), sortKey: "a1", showUpDate: null },
      { ...task("b", "second", "1"), sortKey: "a3", showUpDate: null },
    ]);
    measureTaskRows();
    renderApp(["/projects/1"]);
    await screen.findByRole("button", { name: 'Reorder "second"' });
    await moveWithKeyboard("second", "ArrowUp");

    const first = screen.getByRole("button", { name: 'Complete "first"' }).closest("li")!;
    expect(within(first).getByRole("button", { name: "Add a date" })).toBeEnabled();
  });

  it("completes a task from the detail screen and offers Undo that reopens it", async () => {
    setApi([project("1", "Run a 5K", "next")], [task("t1", "buy running shoes", "1")]);
    renderApp(["/projects/1"]);
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
    expect(screen.getByRole("textbox", { name: "What are you waiting for?" })).toBeInTheDocument();
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
      screen.getByRole("textbox", { name: "What are you waiting for?" }),
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
          recurrence: null,
          recurrenceDate: null,
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
    h.replica = null;
    __resetIconSuggestions();
    fetchMock.mockReset();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    respondIcons(["🌟", "🚀"]);
  });

  const typeTitle = async (value: string) => {
    fireEvent.change(await screen.findByRole("textbox", { name: "Name an outcome" }), { target: { value } });
  };
  const addProject = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
  };
  const createdIcon = (title: string) =>
    h.replica!.snapshot().projects.find((item) => item.title === title)?.icon;

  it("suggests icons while the title is typed and creates the Project with the top one", async () => {
    setApi([]);
    renderApp();
    await typeTitle("Run a 5K");
    expect(await screen.findByRole("button", { name: "Use icon 🌟" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Suggested")).toBeInTheDocument();
    const [, init] = suggestionCalls()[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ title: "Run a 5K", description: null });

    await addProject();
    await waitFor(() => expect(createdIcon("Run a 5K")).toBe("🌟"));
    expect(suggestionCalls().length).toBe(1);
  });

  it("keeps a picked icon while suggestions keep updating", async () => {
    setApi([]);
    renderApp();
    await typeTitle("Run a 5K");
    fireEvent.click(await screen.findByRole("button", { name: "Use icon 🚀" }));
    respondIcons(["🏃", "👟"]);
    await typeTitle("Run a 5K in May");
    expect(await screen.findByRole("button", { name: "Use icon 🏃" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("img", { name: "Icon 🚀" })).toBeInTheDocument();

    await addProject();
    await waitFor(() => expect(createdIcon("Run a 5K in May")).toBe("🚀"));
  });

  it("creates the Project with the default icon when suggestions fail", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    setApi([]);
    renderApp();
    await typeTitle("Run a 5K");
    await waitFor(() => expect(suggestionCalls().length).toBe(1));
    await addProject();
    await waitFor(() => expect(createdIcon("Run a 5K")).toBe("📁"));
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
