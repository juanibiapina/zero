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

const after = (): WaitingCondition => ({
  id: "after",
  projectId: "source",
  kind: "project-status",
  text: null,
  refId: "target",
  targetStatus: "done",
  resolvedAt: null,
  createdAt: "2026-02-01T00:00:00.000Z",
});

describe("projectStatusContext", () => {
  it("identifies the target and ordering for an After Project", () => {
    const source = project("source");
    expect(
      projectStatusContext(
        source,
        [],
        [after()],
        [source, project("target", "Sell old house", "🏠")],
        TODAY,
      ),
    ).toEqual({
      label: "🏠 Sell old house",
      rowLabel: "after 🏠 Sell old house",
      sortKey: "2026-02-01T00:00:00.000Z",
    });
  });

  it("keeps ordinary Waiting context", () => {
    const source = project("source");
    const wait: WaitingCondition = {
      ...after(),
      kind: "free-text",
      text: "the letter arrives",
      refId: null,
      targetStatus: null,
    };
    expect(
      projectStatusContext(
        source,
        [],
        [wait],
        [source],
        TODAY,
        new Date("2026-06-01T00:00:00.000Z"),
      )?.label,
    ).toBe("for 4 months");
  });
});
