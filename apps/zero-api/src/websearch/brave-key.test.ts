import { describe, expect, it } from "vitest";
import { selectBraveKey } from "./brave-key";

describe("selectBraveKey", () => {
  it("uses the paid key and paid cohort when flagged and a paid key exists", () => {
    expect(
      selectBraveKey({ paid: true, freeKey: "free", paidKey: "paid" }),
    ).toEqual({ apiKey: "paid", cohort: "paid" });
  });

  it("uses the free key and free cohort when not flagged", () => {
    expect(
      selectBraveKey({ paid: false, freeKey: "free", paidKey: "paid" }),
    ).toEqual({ apiKey: "free", cohort: "free" });
  });

  it("falls back to the free key when flagged but no paid key is configured", () => {
    expect(
      selectBraveKey({ paid: true, freeKey: "free", paidKey: undefined }),
    ).toEqual({ apiKey: "free", cohort: "free" });
    expect(
      selectBraveKey({ paid: true, freeKey: "free", paidKey: "" }),
    ).toEqual({ apiKey: "free", cohort: "free" });
  });
});
