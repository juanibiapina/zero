import { describe, expect, it } from "vitest";

import { projectStatusContext } from "./status-context";
import type { Project } from "./types";
import type { WaitingCondition } from "../waits/types";

const TODAY = "2026-06-01";

const project = (id: string, title = id, icon = "📁"): Project => ({
  id,
  title,
  icon,
  description: null,
  state: "in-play",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const dependency = (): WaitingCondition => ({
  id: "dependency",
  projectId: "dependent",
  kind: "project-status",
  text: null,
  refId: "prerequisite",
  targetStatus: "done",
  resolvedAt: null,
  createdAt: "2026-02-01T00:00:00.000Z",
});

describe("projectStatusContext", () => {
  it("identifies the prerequisite and ordering for a Blocked project", () => {
    const dependent = project("dependent");
    expect(
      projectStatusContext(
        dependent,
        [],
        [dependency()],
        [dependent, project("prerequisite", "Sell old house", "🏠")],
        TODAY,
      ),
    ).toEqual({
      label: "after 🏠 Sell old house",
      sortKey: "2026-02-01T00:00:00.000Z",
    });
  });

  it("keeps ordinary Waiting context", () => {
    const dependent = project("dependent");
    const wait: WaitingCondition = {
      ...dependency(),
      kind: "free-text",
      text: "the letter arrives",
      refId: null,
      targetStatus: null,
    };
    expect(
      projectStatusContext(
        dependent,
        [],
        [wait],
        [dependent],
        TODAY,
        new Date("2026-06-01T00:00:00.000Z"),
      )?.label,
    ).toBe("for 4 months");
  });
});
