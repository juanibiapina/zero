import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory";
import { SystemTopicStore, SYSTEM_TOPICS } from "./system-topics";
import type { Store } from "./types";

const makeStore = (): Store =>
  new SystemTopicStore(new MemoryStore(() => "2026-01-01T00:00:00.000Z"));

describe("SystemTopicStore: reads overlay bundled topics", () => {
  it("listTopics includes user and system topics, system marked", () => {
    const s = makeStore();
    s.createTopic("weather", "climate notes");
    const names = s.listTopics().map((t) => t.name);
    for (const def of SYSTEM_TOPICS) expect(names).toContain(def.name);
    expect(names).toContain("weather");
    const zero = s.listTopics().find((t) => t.name === "Zero");
    expect(zero?.system).toBe(true);
    expect(s.listTopics().find((t) => t.name === "weather")?.system).toBe(false);
  });

  it("getTopic returns a bundled system topic with body", () => {
    const s = makeStore();
    const zero = s.getTopic("Zero");
    expect(zero?.system).toBe(true);
    expect(zero?.body).toContain("Zero");
    const changelog = s.getTopic("Changelog")?.body ?? "";
    expect(changelog).toContain("Changelog");
    // The agent changelog must not carry console (Vault/Errors) entries.
    expect(changelog).not.toContain("Show resolved");
    expect(changelog).not.toContain("product switcher");
  });

  it("getTopic delegates for unknown and user topics", () => {
    const s = makeStore();
    expect(s.getTopic("nope")).toBeNull();
    s.createTopic("weather", "");
    expect(s.getTopic("weather")?.system).toBe(false);
  });

  it("getPinnedTopics includes pinned system topics (Zero)", () => {
    const s = makeStore();
    const pinnedNames = s.getPinnedTopics().map((t) => t.name);
    expect(pinnedNames).toContain("Zero");
    expect(pinnedNames).not.toContain("Changelog");
  });

  it("getTopicsWithBodies injects requested system topics", () => {
    const s = makeStore();
    s.createTopic("weather", "");
    const got = s.getTopicsWithBodies(["Zero", "weather"]);
    expect(got.map((t) => t.name)).toEqual(["Zero", "weather"]);
  });

  it("getBacklinks resolves a user topic linking a system topic", () => {
    const s = makeStore();
    s.createTopic("notes", "");
    s.saveTopic("notes", { body: "see [[Zero]]", description: "" });
    expect(s.getBacklinks("Zero").map((t) => t.name)).toEqual(["notes"]);
  });
});

describe("SystemTopicStore: writes to system topics are rejected", () => {
  it("createTopic on a reserved name throws", () => {
    expect(() => makeStore().createTopic("Zero", "x")).toThrow(/read-only/);
  });

  it("updateTopicBody / saveTopic / deleteTopic / setPinned throw", () => {
    const s = makeStore();
    expect(() => s.updateTopicBody("Zero", "x")).toThrow(/read-only/);
    expect(() =>
      s.saveTopic("Zero", { body: "x", description: "" }),
    ).toThrow(/read-only/);
    expect(() => s.deleteTopic("Changelog")).toThrow(/read-only/);
    expect(() => s.setPinned("Zero", false)).toThrow(/read-only/);
  });

  it("renaming a user topic onto a reserved name throws", () => {
    const s = makeStore();
    s.createTopic("draft", "");
    expect(() =>
      s.saveTopic("draft", { body: "", description: "" }, "Zero"),
    ).toThrow(/read-only/);
  });

  it("user-topic writes are unaffected", () => {
    const s = makeStore();
    s.createTopic("weather", "notes");
    s.saveTopic("weather", { body: "sunny", description: "" });
    expect(s.getTopic("weather")?.body).toBe("sunny");
    s.deleteTopic("weather");
    expect(s.getTopic("weather")).toBeNull();
  });
});

describe("SystemTopicStore: settings / link / idempotency pass through", () => {
  it("settings reads and writes reach the inner store", () => {
    const s = makeStore();
    expect(s.getSettings().isNewUser).toBe(true);
    s.updateSettings({ onboardingSeen: true });
    expect(s.getSettings().onboardingSeen).toBe(true);
    s.setGoogleOnboardingStatus("done");
    expect(s.getSettings().googleOnboardingStatus).toBe("done");
  });

  it("telegram link and unlink reach the inner store", () => {
    const s = makeStore();
    expect(s.getTelegramId()).toBeNull();
    expect(s.linkTelegram("999")).toEqual({ previous: null });
    expect(s.getTelegramId()).toBe("999");
    expect(s.unlinkTelegram()).toEqual({ removed: "999" });
  });

  it("markProcessed reaches the inner store", () => {
    const s = makeStore();
    expect(s.markProcessed("u1")).toBe(true);
    expect(s.markProcessed("u1")).toBe(false);
  });
});
