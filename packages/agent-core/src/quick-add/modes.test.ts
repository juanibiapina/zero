import { describe, expect, it } from "vitest";

import {
  ADD_MODE_LABEL,
  ADD_MODE_PLACEHOLDER,
  ALL_ADD_MODES,
  addModeA11yLabel,
  type AddMode,
} from "./modes";

describe("add-mode registry", () => {
  it("offers the three modes in display order", () => {
    expect(ALL_ADD_MODES).toEqual(["capture", "task", "project"]);
  });

  it("has a label and placeholder for every mode", () => {
    for (const mode of ALL_ADD_MODES) {
      expect(ADD_MODE_LABEL[mode]).toBeTruthy();
      expect(ADD_MODE_PLACEHOLDER[mode]).toBeTruthy();
    }
  });

  it("derives the pill accessibility label from the mode word", () => {
    const cases: Record<AddMode, string> = {
      capture: "Add a capture",
      task: "Add a task",
      project: "Add a project",
    };
    for (const mode of ALL_ADD_MODES) {
      expect(addModeA11yLabel(mode)).toBe(cases[mode]);
    }
  });
});
