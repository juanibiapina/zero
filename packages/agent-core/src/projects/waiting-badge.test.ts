import { describe, expect, it } from "vitest";

import type { Project } from "./types";
import type { Task } from "../taskdo/types";
import type { ManualWaitingCondition } from "../taskdo/types";
import { waitingBadge } from "./waiting-badge";

const TODAY = "2026-06-01";
// A stable "now" for the elapsed label: a month after a condition created on
// 2026-01-15, so waitingLabel reads a fixed phrase.
const NOW = new Date("2026-06-01T00:00:00.000Z");

function project(over: Partial<Project> = {}): Project {
  return {
    id: over.id ?? "p",
    title: over.title ?? "p",
    icon: "📁",
    description: null,
    state: over.state ?? "in-play",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function task(over: Partial<Task>): Task {
  return {
    id: over.id ?? "t",
    text: "t",
    showUpDate: over.showUpDate !== undefined ? over.showUpDate : "2026-01-01",
    recurrence: over.recurrence ?? null,
    recurrenceDate: over.recurrenceDate ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    projectId: over.projectId ?? "p",
    sortKey: over.sortKey ?? null,
  };
}

function condition(
  over: Partial<ManualWaitingCondition>,
): ManualWaitingCondition {
  return {
    id: over.id ?? "c",
    projectId: over.projectId ?? "p",
    kind: "free-text",
    text: over.text ?? "a reply",
    refId: null,
    targetStatus: null,
    resolvedAt: over.resolvedAt ?? null,
    createdAt: over.createdAt ?? "2026-01-15T00:00:00.000Z",
  };
}

describe("waitingBadge", () => {
  it("is null when the project is not waiting", () => {
    expect(waitingBadge(project(), [], [], [], TODAY, NOW)).toBeNull();
    const active = task({ showUpDate: "2026-01-01" });
    expect(waitingBadge(project(), [active], [], [], TODAY, NOW)).toBeNull();
  });

  it("labels a condition wait with the elapsed time and an 'a:' sort key", () => {
    const badge = waitingBadge(
      project(),
      [],
      [condition({ createdAt: "2026-01-15T00:00:00.000Z" })],
      [],
      TODAY,
      NOW,
    );
    expect(badge?.label).toBe("for 5 months");
    expect(badge?.sortKey).toBe("a:2026-01-15T00:00:00.000Z");
  });

  it("leaves a sub-minute condition wait as an unprefixed 'just now'", () => {
    const badge = waitingBadge(
      project(),
      [],
      [condition({ createdAt: "2026-05-31T23:59:30.000Z" })],
      [],
      TODAY,
      NOW,
    );
    expect(badge?.label).toBe("just now");
  });

  it("labels a date wait with the target day and a 'b:' sort key", () => {
    const future = task({ showUpDate: "2026-07-15" });
    const badge = waitingBadge(project(), [future], [], [], TODAY, NOW);
    expect(badge?.label).toBe("until Wednesday, Jul 15");
    expect(badge?.sortKey).toBe("b:2026-07-15");
  });

  it("orders condition waits before date waits (a: < b:)", () => {
    const condBadge = waitingBadge(
      project(),
      [],
      [condition({})],
      [],
      TODAY,
      NOW,
    );
    const dateBadge = waitingBadge(
      project(),
      [task({ showUpDate: "2026-07-15" })],
      [],
      [],
      TODAY,
      NOW,
    );
    expect(condBadge!.sortKey < dateBadge!.sortKey).toBe(true);
  });
});
