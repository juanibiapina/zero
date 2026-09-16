import { describe, expect, it } from "vitest";

import {
  ADD_MODE_LABEL,
  ADD_MODE_PLACEHOLDER,
  ALL_ADD_MODES,
  addModeA11yLabel,
  type AddMode,
} from "./modes";

describe("add-mode registry", () => {
  it("offers Task then Project", () => {
    expect(ALL_ADD_MODES).toEqual(["task", "project"]);
  });

  it("has copy and an accessibility label for every mode", () => {
    const cases: Record<AddMode, string> = {
      task: "Add a task",
      waiting: "Add a waiting condition",
      after: "Add an After project",
      project: "Add a project",
    };
    for (const mode of Object.keys(cases) as AddMode[]) {
      expect(ADD_MODE_LABEL[mode]).toBeTruthy();
      expect(ADD_MODE_PLACEHOLDER[mode]).toBeTruthy();
      expect(addModeA11yLabel(mode)).toBe(cases[mode]);
    }
  });
});
