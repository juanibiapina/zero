import { afterEach, describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter as RouterMemoryRouter, Route, Routes, useLocation } from "react-router";
import {
  type Project,
  type Task,
  type TaskdoReplica,
  type WaitingCondition,
  defaultToastController,
} from "@zero/agent-core";

import { HomePage } from "./HomePage";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { TodoDataContextProvider, type TodoData } from "@/lib/todo-data";
import { createInMemoryTodoData } from "@/testing/in-memory-todo-data";

// Give the real page a fresh in-memory replica through its public data owner.
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

// A loose task with no show-up date (always shown up on Home).
const taskRow = (id: string, text: string, over: Partial<Task> = {}): Task => ({
  id,
  text,
  showUpDate: over.showUpDate === undefined ? null : over.showUpDate,
  recurrence: over.recurrence ?? null,
  recurrenceDate: over.recurrenceDate ?? null,
  createdAt: over.createdAt ?? `2023-01-0${id}T00:00:00.000Z`,
  completedAt: over.completedAt ?? null,
  projectId: over.projectId ?? null,
  sortKey: over.sortKey ?? null,
});

// Records reschedule calls so tests can assert the scheduler wiring.
const rescheduled: { id: string; showUpDate: string | null }[] = [];

// Records move-to-project calls so tests can assert the project-picker wiring.
const moved: { id: string; projectId: string | null }[] = [];

const projectRow = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  title: over.title ?? id,
  icon: over.icon ?? "📁",
  description: over.description ?? null,
  state: over.state ?? "in-play",
  createdAt: over.createdAt ?? "2023-01-01T00:00:00.000Z",
});

function setApi(
  tasks: Task[] = [],
  projects: Project[] = [],
  waits: WaitingCondition[] = [],
) {
  rescheduled.length = 0;
  moved.length = 0;
  const { data } = createInMemoryTodoData({ tasks, projects, waits });
  const replica = data.replica!;
  h.replica = replica;
  const reschedule = replica.tasks.reschedule;
  replica.tasks.reschedule = (id, showUpDate) => {
    rescheduled.push({ id, showUpDate });
    return reschedule(id, showUpDate);
  };
  const moveToProject = replica.tasks.moveToProject;
  replica.tasks.moveToProject = (id, projectId) => {
    moved.push({ id, projectId });
    return moveToProject(id, projectId);
  };
}

describe("HomePage", () => {
  afterEach(() => {
    h.replica = null;
    defaultToastController.dismiss();
  });

  it("titles the screen Home", async () => {
    setApi();
    render(<HomePage />, { wrapper: MemoryRouter });
    expect(
      await screen.findByRole("heading", { name: "Home", level: 1 }),
    ).toBeInTheDocument();
  });

  it("shows every Next Project when Home is clear", async () => {
    setApi([], [projectRow("p", { title: "First project" }), projectRow("q", { title: "Second project" })]);
    render(<HomePage />, { wrapper: MemoryRouter });
    expect(await screen.findByRole("link", { name: "First project" })).toHaveAttribute("href", "/projects/p");
    expect(screen.getByRole("link", { name: "Second project" })).toHaveAttribute("href", "/projects/q");
    expect(screen.getByRole("heading", { name: "Next" })).toBeInTheDocument();
  });

  it("explains Projects while keeping the existing add flow when Home is clear", async () => {
    setApi();
    render(<HomePage />, { wrapper: MemoryRouter });
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Project" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create your first project" })).toBeNull();
  });

  it("renders a loose task and no CTA", async () => {
    setApi([taskRow("1", "buy milk")], [projectRow("p")]);
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
          showUpDate: "2023-01-01",
        }),
      ],
      [projectRow("p", { icon: "🎓" })],
    );
    render(<HomePage />, { wrapper: MemoryRouter });

    await screen.findByRole("button", { name: 'Complete "mail the letter"' });
    expect(screen.getByText("🎓")).toBeInTheDocument();
  });

  it("shows arrived Project Tasks despite an unresolved After relationship", async () => {
    setApi(
      [
        taskRow("1", "pack boxes", {
          projectId: "p",
          showUpDate: "2023-01-01",
        }),
      ],
      [projectRow("p", { title: "Move house" })],
      [
        {
          id: "dependency",
          projectId: "p",
          kind: "project-status",
          text: null,
          refId: "missing-prerequisite",
          targetStatus: "done",
          resolvedAt: null,
          createdAt: "2023-01-01T00:00:00.000Z",
        },
      ],
    );
    render(<HomePage />, { wrapper: MemoryRouter });

    expect(await screen.findByText("pack boxes")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs attention right now")).toBeNull();
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

  it("creates a recurring task from natural-language quick add", async () => {
    setApi();
    render(<HomePage />, { wrapper: MemoryRouter });

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Add a task" }),
      { target: { value: "stand up every day" } },
    );
    expect(screen.getByTestId("schedule-highlight")).toHaveTextContent(
      "every day",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Edit "stand up", Every day' }),
      ).toBeInTheDocument(),
    );
  });

  it("highlights only a one-time date and leaves time words in the draft", async () => {
    setApi();
    render(<HomePage />, { wrapper: MemoryRouter });

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Add a task" }),
      { target: { value: "Call Ana tomorrow at 3pm" } },
    );

    expect(screen.getByTestId("schedule-highlight")).toHaveTextContent(
      "tomorrow",
    );
    expect(screen.getByTestId("schedule-highlight-mirror")).toHaveTextContent(
      "Call Ana tomorrow at 3pm",
    );
  });

  it("falls back to the previous date when the active highlight is dismissed", async () => {
    setApi();
    render(<HomePage />, { wrapper: MemoryRouter });

    const input = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Add a task",
    });
    fireEvent.change(input, { target: { value: "Work today tomorrow" } });
    expect(screen.getByTestId("schedule-highlight")).toHaveTextContent(
      "tomorrow",
    );

    input.setSelectionRange(14, 14);
    fireEvent.pointerUp(input);
    expect(screen.getByTestId("schedule-highlight")).toHaveTextContent("today");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: 'Edit "Work tomorrow"' }),
      ).toBeInTheDocument(),
    );
  });

  it("files a dateless task to a project from the composer: off Home, with a toast", async () => {
    setApi([], [projectRow("p", { title: "Diploma", icon: "🎓" })]);
    render(<HomePage />, { wrapper: MemoryRouter });

    // Pick the project in the quick-add composer's project chip.
    fireEvent.click(await screen.findByRole("button", { name: "Add to a project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Diploma" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Add a task" }), {
      target: { value: "write thesis" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    // A dateless project task is groomed: it does NOT appear on Home.
    await waitFor(() =>
      expect(defaultToastController.getSnapshot()).toHaveLength(1),
    );
    expect(defaultToastController.getSnapshot()[0].message).toBe(
      "Filed to project",
    );
    expect(
      screen.queryByRole("button", { name: 'Edit "write thesis"' }),
    ).toBeNull();
  });

  it("searches both Task-assignment Project menus", async () => {
    setApi([taskRow('1', 'Loose task')], [
      ...Array.from({ length: 6 }, (_, i) => projectRow(`b${i}`, { title: `Backlog ${i}`, state: 'backlog' })),
    ]);
    render(<HomePage />, { wrapper: MemoryRouter });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to a project' }));
    expect(screen.getByRole('button', { name: 'Backlog, 6' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter projects' }),
      { target: { value: 'backlog 5' } });
    expect(screen.getByRole('button', { name: 'Backlog 5' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to a project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit "Loose task"' }));
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(screen.getByRole('textbox', { name: 'Filter projects' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter projects' }),
      { target: { value: 'backlog 5' } });
    expect(screen.getByRole('button', { name: 'Backlog 5' })).toBeInTheDocument();
  });

  it("groups both Project selectors using future work outside Home", async () => {
    setApi([
      taskRow('1', 'Loose task'),
      taskRow('2', 'Future work', { projectId: 'p', showUpDate: '2099-01-01' }),
    ], [projectRow('p', { title: 'Future project' }), projectRow('n', { title: 'Next project' })]);
    render(<HomePage />, { wrapper: MemoryRouter });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to a project' }));
    expect(screen.getByRole('button', { name: 'Waiting, 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next, 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to a project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit "Loose task"' }));
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(screen.getByRole('button', { name: 'Waiting, 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Future project' })).toBeInTheDocument();
  });

  it("creates a project from the Project mode, stays on Home, and toasts a link to it", async () => {
    setApi();
    function Probe() {
      return <output aria-label="Current path">{useLocation().pathname}</output>;
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
    expect(screen.getByRole("status", { name: "Current path" })).toHaveTextContent("/");
    const [t] = defaultToastController.getSnapshot();
    expect(t.message).toBe("Project created");
    expect(t.description).toBe("ship the app");
    expect(t.action?.label).toBe("View");

    await act(async () => {
      t.action?.onPress();
    });
    await waitFor(() => expect(screen.getByRole("status", { name: "Current path" }))
      .toHaveTextContent(/^\/projects\/.+/));
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

  it("groups eligible After targets in both Project detail selectors", async () => {
    setApi([], [projectRow('source'), projectRow('target'),
      ...Array.from({ length: 6 }, (_, i) => projectRow(`backlog ${i}`, { state: 'backlog' }))], [
      { id: 'link', projectId: 'source', kind: 'project-status', text: null,
        refId: 'target', targetStatus: 'done', createdAt: '2023-01-01', resolvedAt: null },
    ]);
    render(<MemoryRouter initialEntries={['/projects/source']}>
      <Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes>
    </MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add to source' }));
    fireEvent.click(screen.getByRole('button', { name: 'After project' }));
    expect(await screen.findByRole('button', { name: 'Backlog, 6' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter After projects' }),
      { target: { value: 'backlog 5' } });
    expect(screen.getByRole('button', { name: 'backlog 5' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'target' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add After project' }));
    expect(screen.getByRole('button', { name: 'Backlog, 6' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter After projects' }),
      { target: { value: 'backlog 5' } });
    expect(screen.getByRole('button', { name: 'backlog 5' })).toBeInTheDocument();
  });

  it("moves a loose task into a project from the detail sheet", async () => {
    setApi(
      [taskRow("1", "buy milk")],
      [projectRow("p", { title: "Groceries" })],
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
