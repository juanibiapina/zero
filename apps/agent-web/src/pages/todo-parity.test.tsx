import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskdoReplica, defaultToastController, localToday, tomorrow, type Project, type Task, type TaskdoReplica } from "@zero/agent-core";
import { QueryClient } from "@tanstack/react-query";
import { createMergeableStore } from "tinybase";
import { parseSchedule, toText } from "@zeroapps/recurrence";
import { TodoDataContextProvider } from "@/lib/todo-data";
import { createInMemoryTodoData, type InMemoryTodoSeed } from "@/testing/in-memory-todo-data";
import { HomePage } from "./HomePage";
import { UpcomingPage } from "./UpcomingPage";
import { ProjectsPage } from "./ProjectsPage";
import { ProjectDetailPage } from "./ProjectDetailPage";

const project = (id: string, title: string, state: Project["state"] = "in-play"): Project => ({ id, title, state, icon: "🏠", description: null, createdAt: "2026-09-01T12:00:00Z" });
const task = (id: string, text: string, fields: Partial<Task> = {}): Task => ({ id, text, projectId: null, showUpDate: null, recurrence: null, recurrenceDate: null, completedAt: null, sortKey: "a1", createdAt: "2026-09-01T12:00:00Z", ...fields });
const opened: TaskdoReplica[] = [];
function open(path: string, seed: InMemoryTodoSeed = {}) {
  const todo = createInMemoryTodoData(seed);
  opened.push(todo.replica);
  render(<TodoDataContextProvider value={{ ...todo.data, authenticatedFeatures: false }}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/home" element={<HomePage />} />
    <Route path="/upcoming" element={<UpcomingPage />} />
    <Route path="/projects" element={<ProjectsPage />} />
    <Route path="/projects/:id" element={<ProjectDetailPage />} />
  </Routes></MemoryRouter></TodoDataContextProvider>);
  return todo.replica;
}
afterEach(async () => {
  cleanup();
  defaultToastController.dismiss();
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((replica) => replica.close()));
});

async function rename(oldText: string, text: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Edit "${oldText}"` }));
  fireEvent.change(screen.getByRole("textbox", { name: "Task text" }), { target: { value: text } });
}

describe("web todo parity", () => {
  it("keeps a Home title edit when a reschedule removes it from the list", async () => {
    const replica = open("/home", { tasks: [task("t", "Original")] });
    await rename("Original", "Edited before scheduling");
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(replica.snapshot().tasks[0]).toMatchObject({ text: "Edited before scheduling", showUpDate: tomorrow(localToday()) });
  });

  it.each(["/home", "/upcoming", "/projects/p"])("keeps edited titles through completion and Undo from %s", async (path) => {
    const replica = open(path, { projects: [project("p", "Renovate")], tasks: [task("t", "Original", { projectId: "p", showUpDate: path === "/upcoming" ? tomorrow(localToday()) : localToday() })] });
    await rename("Original", "Edited before completion");
    fireEvent.click(screen.getByRole("button", { name: "Complete task" }));
    await act(async () => { defaultToastController.getSnapshot().find((toast) => toast.message === "Completed")!.action!.onPress(); });
    await waitFor(() => expect(replica.snapshot().tasks[0].text).toBe("Edited before completion"));
    expect(replica.snapshot().tasks[0].completedAt).toBeNull();
  });

  it("keeps a title updated elsewhere when completing an unchanged open draft", async () => {
    const replica = open("/home", { tasks: [task("t", "Original")] });
    fireEvent.click(await screen.findByRole("button", { name: 'Edit "Original"' }));
    await act(async () => { await replica.tasks.edit("t", "Updated elsewhere").isPersisted.promise; });
    fireEvent.click(screen.getByRole("button", { name: "Complete task" }));
    await act(async () => { defaultToastController.getSnapshot().find((entry) => entry.message === "Completed")!.action!.onPress(); });
    await waitFor(() => expect(replica.snapshot().tasks[0]).toMatchObject({ text: "Updated elsewhere", completedAt: null }));
  });

  it("moves an Upcoming Task to loose while keeping its edited title and date", async () => {
    const date = tomorrow(localToday());
    const replica = open("/upcoming", { projects: [project("p", "Renovate")], tasks: [task("t", "Original", { projectId: "p", showUpDate: date })] });
    await rename("Original", "Moved loose");
    fireEvent.click(screen.getByRole("button", { name: "Renovate" }));
    fireEvent.click(screen.getByRole("button", { name: "No project" }));
    await waitFor(() => expect(replica.snapshot().tasks[0]).toMatchObject({ projectId: null, text: "Moved loose", showUpDate: date }));
  });

  it("saves a Task draft before navigating directly to its Project", async () => {
    const replica = open("/home", { projects: [project("p", "Renovate")], tasks: [task("t", "Original", { projectId: "p", showUpDate: localToday() })] });
    await rename("Original", "Edited before navigation");
    fireEvent.click(screen.getByRole("button", { name: "Open project Renovate" }));
    expect(await screen.findByRole("textbox", { name: "Project title" })).toHaveValue("Renovate");
    expect(replica.snapshot().tasks[0].text).toBe("Edited before navigation");
  });

  it.each(["/upcoming", "/projects/p"])("can complete a repeat forever and Undo from %s", async (path) => {
    const parsed = parseSchedule("Inspect every day", { today: tomorrow(localToday()), weekStartsOn: "MO" });
    if (parsed.kind !== "scheduled" || parsed.schedule.kind !== "recurring") throw new Error("Expected repeat");
    const before = task("t", "Inspect", { projectId: "p", showUpDate: tomorrow(localToday()), recurrence: parsed.schedule.recurrence, recurrenceDate: parsed.schedule.recurrence.origin });
    const replica = open(path, { projects: [project("p", "Renovate")], tasks: [before] });
    fireEvent.click(await screen.findByRole("button", { name: 'Edit "Inspect"' }));
    fireEvent.click(screen.getByRole("button", { name: "every day" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete forever" }));
    await act(async () => { defaultToastController.getSnapshot().find((toast) => toast.message === "Completed forever")!.action!.onPress(); });
    await waitFor(() => expect(replica.snapshot().tasks[0]).toEqual(before));
  });

  it("creates a recurring Task with its owning Project from the Project workspace", async () => {
    const replica = open("/projects/p", { projects: [project("p", "Renovate")] });
    fireEvent.click(await screen.findByRole("button", { name: "Add to Renovate" }));
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Add a task" }), { target: { value: "Inspect every Monday" } });
    expect(screen.getByTestId("schedule-highlight")).toHaveTextContent("every Monday");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(replica.snapshot().tasks[0]).toMatchObject({ text: "Inspect", projectId: "p" });
    expect(toText(replica.snapshot().tasks[0].recurrence!)).toBe("every week on Monday");
  });

  it("creates a scheduled Task from Projects without creating another Project", async () => {
    const replica = open("/projects", { projects: [project("p", "Renovate")] });
    fireEvent.click(await screen.findByRole("radio", { name: "Task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Add a task" }), { target: { value: "Buy tools tomorrow" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to a project" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Renovate" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(replica.snapshot().tasks[0]).toMatchObject({ text: "Buy tools", projectId: "p", showUpDate: tomorrow(localToday()) }));
    expect(replica.snapshot().projects).toHaveLength(1);
  });

  it("retains a failed addition and retries its local save without duplicating it", async () => {
    const replica = createTaskdoReplica({ store: createMergeableStore(), queryClient: new QueryClient(), queryKeyScope: ["failed-add"], save: async () => { throw new Error("Disk unavailable"); } });
    const base = createInMemoryTodoData();
    opened.push(replica, base.replica);
    render(<TodoDataContextProvider value={{ ...base.data, replica, authenticatedFeatures: false, saveLocal: async () => {} }}><MemoryRouter><HomePage /></MemoryRouter></TodoDataContextProvider>);
    const input = await screen.findByRole("textbox", { name: "Add a task" });
    fireEvent.change(input, { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByRole("button", { name: "Try saving again" });
    expect(input).toHaveValue("Keep my draft");
    expect(defaultToastController.getSnapshot().some((entry) => entry.message === "Could not save your change" && entry.description?.includes("Disk unavailable"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try saving again" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(replica.snapshot().tasks.map((item) => item.text)).toEqual(["Keep my draft"]);
  });

  it("keeps a Project add draft until discard is explicitly chosen", async () => {
    const replica = open("/projects/p", { projects: [project("p", "Renovate")] });
    fireEvent.click(await screen.findByRole("button", { name: "Add to Renovate" }));
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Add a task" }), { target: { value: "Unfinished draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Discard draft?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveValue("Unfinished draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(replica.snapshot().tasks).toEqual([]);
  });

  it("offers lifecycle actions from Project status", async () => {
    const replica = open("/projects/p", { projects: [project("p", "Renovate", "backlog")] });
    fireEvent.click(await screen.findByRole("button", { name: "Project status: Backlog" }));
    fireEvent.click(screen.getByRole("button", { name: "Move out of backlog" }));
    await waitFor(() => expect(replica.snapshot().projects[0].state).toBe("in-play"));
  });

  it.each(["/home", "/upcoming"])("updates available work on foreground return in %s without a write", async (path) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 30, 12));
    const replica = open(path, { projects: [project("p", "Renovate")], tasks: [task("t", "Due on October 1", { projectId: "p", showUpDate: "2026-10-01" })] });
    if (path === "/home") await screen.findByRole("region", { name: "Home is clear" });
    else await screen.findByRole("button", { name: 'Edit "Due on October 1"' });
    const before = replica.snapshot();
    act(() => { vi.setSystemTime(new Date(2026, 9, 1, 12)); window.dispatchEvent(new Event("focus")); });
    await waitFor(() => {
      if (path === "/home") expect(screen.getByRole("button", { name: 'Edit "Due on October 1"' })).toBeInTheDocument();
      else expect(screen.queryByRole("button", { name: 'Edit "Due on October 1"' })).toBeNull();
    });
    expect(replica.snapshot()).toEqual(before);
  });

  it("shows every Waiting Project and keeps Backlog and After out of clear Home", async () => {
    open("/home", { projects: [project("p", "First waiting"), project("q", "Second waiting"), project("back", "Backlog", "backlog"), project("after", "After project")], tasks: [task("t", "Later", { projectId: "p", showUpDate: tomorrow(localToday()) })], waits: [
      { id: "w", projectId: "q", kind: "free-text", text: "A reply", createdAt: "2026-09-01T12:00:00Z", resolvedAt: null, refId: null, targetStatus: null },
      { id: "a", projectId: "after", kind: "project-status", text: null, createdAt: "2026-09-01T12:00:00Z", resolvedAt: null, refId: "p", targetStatus: "done" },
    ] });
    const region = await screen.findByRole("region", { name: "Home is clear" });
    expect(within(region).getByRole("link", { name: /First waiting/ })).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: /Second waiting/ })).toBeInTheDocument();
    expect(within(region).queryByText("Backlog")).toBeNull();
    expect(within(region).queryByText("After project")).toBeNull();
  });
});
