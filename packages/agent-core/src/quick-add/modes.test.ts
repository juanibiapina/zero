import { describe, expect, it } from "vitest";

import {
  ADD_MODE_LABEL,
  ADD_MODE_PLACEHOLDER,
  ALL_ADD_MODES,
  addModeA11yLabel,
  type AddMode,
} from "./modes";

describe("add-mode registry", () => {
  it("offers the global modes in display order (task default, then project)", () => {
    expect(ALL_ADD_MODES).toEqual(["task", "project"]);
  });

  it("keeps the project-scoped 'waiting' mode out of the global set", () => {
    // 'waiting' creates on the open project, so it is never offered where there
    // is no project context (Home, the Projects list); the project screen passes
    // it explicitly. It still carries a label and placeholder.
    expect(ALL_ADD_MODES).not.toContain("waiting");
    expect(ADD_MODE_LABEL.waiting).toBe("Waiting");
    expect(ADD_MODE_PLACEHOLDER.waiting).toBe("Waiting on…");
  });

  it("has a label and placeholder for every mode", () => {
    for (const mode of ["task", "project", "waiting"] as AddMode[]) {
      expect(ADD_MODE_LABEL[mode]).toBeTruthy();
      expect(ADD_MODE_PLACEHOLDER[mode]).toBeTruthy();
    }
  });

  it("labels each mode's pill for accessibility ('waiting' is spelled out)", () => {
    const cases: Record<AddMode, string> = {
      task: "Add a task",
      project: "Add a project",
      waiting: "Add a waiting condition",
    };
    for (const mode of Object.keys(cases) as AddMode[]) {
      expect(addModeA11yLabel(mode)).toBe(cases[mode]);
    }
  });
});
