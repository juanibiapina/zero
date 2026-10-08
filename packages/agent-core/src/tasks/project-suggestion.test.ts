import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectParent } from "./parent";

import type { Project, Task } from "../taskdo/types";
import {
  ProjectSuggester,
  projectSuggestionCandidates,
  type ProjectSuggestionCandidate,
  type ProjectSuggestionRequest,
} from "./project-suggestion";

const candidate = (id: string): ProjectSuggestionCandidate => ({ id, title: id, icon: "📁", description: null, tasks: [] });
const bathroom = candidate("bathroom");
const trip = candidate("trip");
const candidates = [bathroom, trip];

const deferred = () => {
  const calls: { title: string; resolve: (id: string | null) => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
  const request = vi.fn<ProjectSuggestionRequest>(
    (input, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ title: input.title, resolve, reject, signal });
      }),
  );
  return { request, calls };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ProjectSuggester", () => {
  it("asks once after typing pauses and selects the answer as suggested", async () => {
    const { request, calls } = deferred();
    const suggester = new ProjectSuggester({ request });
    for (const title of ["buy", "buy gr", "buy grout"]) {
      suggester.update({ title, candidates, enabled: true });
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(400);

    expect(request).toHaveBeenCalledOnce();
    expect(calls[0]?.title).toBe("buy grout");
    calls[0]?.resolve("bathroom");
    await flush();

    expect(suggester.getState().selection).toEqual({ projectId: "bathroom", source: "suggested" });
  });

  it("drops an answer for text the user has since changed", async () => {
    const { request, calls } = deferred();
    const suggester = new ProjectSuggester({ request });
    suggester.update({ title: "buy grout", candidates, enabled: true });
    vi.advanceTimersByTime(400);
    suggester.update({ title: "book flights", candidates, enabled: true });

    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.resolve("bathroom");
    await flush();
    expect(suggester.getState().selection.projectId).toBeNull();

    vi.advanceTimersByTime(400);
    calls[1]?.resolve("trip");
    await flush();
    expect(suggester.getState().selection).toEqual({ projectId: "trip", source: "suggested" });
  });

  it("never replaces a Project the user picked, including No project", async () => {
    const { request } = deferred();
    const suggester = new ProjectSuggester({ request });
    suggester.pick(null);
    suggester.update({ title: "buy grout", candidates, enabled: true });
    vi.advanceTimersByTime(1000);

    expect(request).not.toHaveBeenCalled();
    expect(suggester.getState().selection).toEqual({ projectId: null, source: "manual" });
  });

  it("never asks when the screen chose the Project or suggestions are off", () => {
    const { request } = deferred();
    const inProject = new ProjectSuggester({ request, initial: { projectId: "trip", source: "context" } });
    inProject.update({ title: "buy grout", candidates, enabled: true });
    const guest = new ProjectSuggester({ request });
    guest.update({ title: "buy grout", candidates, enabled: false });
    vi.advanceTimersByTime(1000);

    expect(request).not.toHaveBeenCalled();
    expect(inProject.getState().selection).toEqual({ projectId: "trip", source: "context" });
  });

  it("clears a suggestion when the request fails or the title gets too short", async () => {
    const { request, calls } = deferred();
    const suggester = new ProjectSuggester({ request });
    suggester.update({ title: "buy grout", candidates, enabled: true });
    vi.advanceTimersByTime(400);
    calls[0]?.resolve("bathroom");
    await flush();

    suggester.update({ title: "buy grout", candidates: [...candidates, candidate("garden")], enabled: true });
    vi.advanceTimersByTime(400);
    expect(suggester.getState().selection.projectId).toBe("bathroom");
    calls[1]?.reject(new Error("offline"));
    await flush();
    expect(suggester.getState().selection).toEqual({ projectId: null, source: "none" });

    suggester.update({ title: "buy grout", candidates, enabled: true });
    vi.advanceTimersByTime(400);
    calls[2]?.resolve("bathroom");
    await flush();
    suggester.update({ title: "bu", candidates, enabled: true });
    expect(suggester.getState().selection).toEqual({ projectId: null, source: "none" });
  });

  it("drops a suggested Project that is no longer a candidate", async () => {
    const { request, calls } = deferred();
    const suggester = new ProjectSuggester({ request });
    suggester.update({ title: "buy grout", candidates, enabled: true });
    vi.advanceTimersByTime(400);
    calls[0]?.resolve("bathroom");
    await flush();

    suggester.update({ title: "buy grout", candidates: [trip], enabled: true });

    expect(suggester.getState().selection.projectId).toBeNull();
  });

  it("drops a suggested Project as soon as the title changes, until the next answer", async () => {
    const { request, calls } = deferred();
    const suggester = new ProjectSuggester({ request });
    suggester.update({ title: "buy grout", candidates, enabled: true });
    vi.advanceTimersByTime(400);
    calls[0]?.resolve("bathroom");
    await flush();

    suggester.update({ title: "buy grout and flights", candidates, enabled: true });
    expect(suggester.getState()).toEqual({ selection: { projectId: null, source: "none" }, loading: true });

    vi.advanceTimersByTime(400);
    calls[1]?.resolve("trip");
    await flush();
    expect(suggester.getState()).toEqual({ selection: { projectId: "trip", source: "suggested" }, loading: false });
  });

  it("keeps a Project the user picked when the title changes", () => {
    const { request } = deferred();
    const suggester = new ProjectSuggester({ request });
    suggester.update({ title: "buy grout", candidates, enabled: true });
    suggester.pick("trip");
    suggester.update({ title: "buy grout now", candidates, enabled: true });

    expect(suggester.getState()).toEqual({ selection: { projectId: "trip", source: "manual" }, loading: false });
  });

  it("is loading from the first keystroke until the answer arrives", async () => {
    const { request, calls } = deferred();
    const suggester = new ProjectSuggester({ request });
    const listener = vi.fn();
    suggester.subscribe(listener);

    suggester.update({ title: "buy", candidates, enabled: true });
    expect(suggester.getState().loading).toBe(true);
    suggester.update({ title: "buy grout", candidates, enabled: true });
    vi.advanceTimersByTime(400);
    expect(suggester.getState().loading).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    calls[0]?.resolve("bathroom");
    await flush();
    expect(suggester.getState()).toEqual({ selection: { projectId: "bathroom", source: "suggested" }, loading: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops loading when the request fails or nothing is left to ask", async () => {
    const { request, calls } = deferred();
    const suggester = new ProjectSuggester({ request });
    suggester.update({ title: "buy grout", candidates, enabled: true });
    vi.advanceTimersByTime(400);
    calls[0]?.reject(new Error("offline"));
    await flush();
    expect(suggester.getState().loading).toBe(false);

    suggester.update({ title: "buy grout now", candidates, enabled: true });
    suggester.update({ title: "bu", candidates, enabled: true });
    expect(suggester.getState().loading).toBe(false);

    suggester.update({ title: "buy grout", candidates, enabled: true });
    suggester.update({ title: "buy grout", candidates, enabled: false });
    expect(suggester.getState().loading).toBe(false);

    suggester.update({ title: "buy grout", candidates, enabled: true });
    suggester.pick(null);
    expect(suggester.getState().loading).toBe(false);

    suggester.reset();
    suggester.update({ title: "buy grout", candidates, enabled: true });
    suggester.reset({ projectId: "trip", source: "context" });
    expect(suggester.getState()).toEqual({ selection: { projectId: "trip", source: "context" }, loading: false });
  });
});

describe("projectSuggestionCandidates", () => {
  const project = (id: string, over: Partial<Project> = {}): Project => ({
    id, title: id, icon: "📁", description: null, state: "in-play", createdAt: "2026-01-01T00:00:00.000Z", ...over,
  });
  const task = (text: string, projectId: string | null, createdAt: string, completedAt: string | null = null): Task => ({
    id: text, text, showUpDate: null, recurrence: null, recurrenceDate: null, createdAt, completedAt, parent: projectParent(projectId), sortKey: null,
  });

  it("offers open Projects, newest first, with up to five newest open Task titles", () => {
    const projects = [
      project("old", { createdAt: "2026-01-01T00:00:00.000Z", description: "x".repeat(400) }),
      project("new", { createdAt: "2026-02-01T00:00:00.000Z" }),
      project("finished", { state: "done" }),
    ];
    const tasks = [
      ...Array.from({ length: 7 }, (_, index) => task(`t${index}`, "old", `2026-03-0${index + 1}T00:00:00.000Z`)),
      task("done one", "old", "2026-04-01T00:00:00.000Z", "2026-04-02T00:00:00.000Z"),
      task("loose", null, "2026-04-01T00:00:00.000Z"),
    ];

    const result = projectSuggestionCandidates(projects, tasks);

    expect(result.map((item) => item.id)).toEqual(["new", "old"]);
    expect(result[1]?.tasks).toEqual(["t6", "t5", "t4", "t3", "t2"]);
    expect(result[1]?.description).toHaveLength(300);
  });
});
