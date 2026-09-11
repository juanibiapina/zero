import { describe, expect, it } from "vitest";

import { localToday } from "./today";

describe("localToday", () => {
  it("formats the local date as YYYY-MM-DD, zero-padded", () => {
    // Local-time constructor so the assertion holds in any timezone.
    expect(localToday(new Date(2024, 0, 5))).toBe("2024-01-05");
    expect(localToday(new Date(2024, 10, 30))).toBe("2024-11-30");
  });
});
