import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { type Project, type Task, type WaitingCondition } from "@zero/agent-core";
import { ProjectOptionList } from "./ProjectOptionList";

const project = (id: string, state: Project["state"] = "in-play"): Project => ({
  id, title: id, state, icon: "📁", description: null, createdAt: "2026-01-01",
});
const projects = [
  project("active"), project("next"), project("waiting"), project("after"),
  project("target"), ...Array.from({ length: 6 }, (_, i) => project(`backlog ${i}`, "backlog")),
  project("done", "done"),
];
const tasks: Task[] = [{
  id: "work", text: "Work", projectId: "active", showUpDate: "2000-01-01",
  completedAt: null, createdAt: "2026-01-01", sortKey: null,
}];
const conditions: WaitingCondition[] = [
  { id: "wait", projectId: "waiting", kind: "free-text", text: "Reply", refId: null,
    targetStatus: null, createdAt: "2026-01-01", resolvedAt: null },
  { id: "after-link", projectId: "after", kind: "project-status", text: null, refId: "target",
    targetStatus: "done", createdAt: "2026-01-01", resolvedAt: null },
];
const props = { projects, tasks, conditions, today: "2026-09-24", onPick: vi.fn() };

describe("ProjectOptionList", () => {
  it("orders status sections and keeps Backlog and After reachable", () => {
    const onPick = vi.fn();
    render(<ProjectOptionList {...props} onPick={onPick} showNoProject selectedProjectId={null} />);
    const headers = screen.getAllByRole("button", { name: /^(Active|Next|Waiting|After|Backlog), / });
    expect(headers.map((header) => header.getAttribute("aria-label"))).toEqual([
      "Active, 1", "Next, 2", "Waiting, 1", "After, 1", "Backlog, 6",
    ]);
    expect(screen.getByRole("button", { name: "After, 1" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Backlog, 6" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "done" })).toBeNull();
    expect(screen.getByRole("button", { name: "No project" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Backlog, 6" }));
    fireEvent.click(screen.getByRole("button", { name: "backlog 0" }));
    expect(onPick).toHaveBeenCalledWith("backlog 0");
  });

  it("keeps Backlog open at five and reveals folded matches without losing the fold", () => {
    const { rerender } = render(<ProjectOptionList {...props} projects={projects.slice(0, -2)} />);
    expect(screen.getByRole("button", { name: "Backlog, 5" })).toHaveAttribute("aria-expanded", "true");
    rerender(<ProjectOptionList {...props} />);
    expect(screen.getByRole("button", { name: "Backlog, 6" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter projects" }), { target: { value: "BACKLOG 5" } });
    expect(screen.getByRole("button", { name: "Backlog, 1" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "backlog 5" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter projects" }), { target: { value: "missing" } });
    expect(screen.getByText("No matching projects")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter projects" }), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Backlog, 6" })).toHaveAttribute("aria-expanded", "false");
  });

  it("restores a manual fold after search", () => {
    render(<ProjectOptionList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Backlog, 6" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter projects" }), { target: { value: "backlog 5" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter projects" }), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Backlog, 6" })).toHaveAttribute("aria-expanded", "true");
  });

  it("groups only eligible After targets against the full Project context", () => {
    const onPick = vi.fn();
    render(<ProjectOptionList {...props} projects={[project("source"), ...projects]}
      conditions={[...conditions, { id: "existing", projectId: "source", kind: "project-status",
        text: null, refId: "target", targetStatus: "done", createdAt: "2026-01-01", resolvedAt: null }]}
      afterSourceProjectId="source" onPick={onPick} emptyCopy="No available projects" />);
    expect(screen.getByRole("button", { name: "Backlog, 6" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter After projects" }), { target: { value: "backlog 5" } });
    expect(screen.getByRole("button", { name: "Backlog, 1" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("button", { name: "No project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "target" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "backlog 5" }));
    expect(onPick).toHaveBeenCalledWith("backlog 5");
  });
});
