import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "./App";

vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  SignIn: () => <div>Sign in</div>,
  UserButton: () => <div>Account</div>,
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
}));

vi.mock("./lib/todo-data", () => ({
  TodoDataProvider: ({ children }: { children: ReactNode }) => children,
  useTodoData: () => ({
    sync: { phase: "synced", lastSyncedAt: null },
    durable: true,
    durabilityError: null,
  }),
}));

vi.mock("./lib/timezone-sync", () => ({
  createWebTimezoneSync: () => ({ onColdStart: vi.fn() }),
}));

vi.mock("./pages/HomePage", () => ({
  HomePage: () => <div>Home task list</div>,
}));

vi.mock("./pages/SettingsPage", () => ({
  SettingsPage: () => <div>Settings</div>,
}));

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      onboardingSeen: true,
      googleOnboardingStatus: null,
      createdAt: null,
      timezone: null,
    }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderAt(path: string) {
  window.history.replaceState({}, "", path);
  render(<App />);
}

it("uses /home as the Home destination", async () => {
  await renderAt("/home");
  await screen.findByText("Home task list");

  expect(window.location.pathname).toBe("/home");
  expect(screen.getAllByRole("link", { name: "Home" })[0]).toHaveAttribute(
    "href",
    "/home",
  );
  expect(screen.getAllByRole("button", { name: "Synced" })).not.toHaveLength(0);
});

it("handles /captures through the ordinary unknown-route fallback", async () => {
  await renderAt("/captures");

  await waitFor(() => expect(window.location.pathname).toBe("/"));
  expect(screen.getByText("Settings")).toBeInTheDocument();
  expect(screen.queryByText("Home task list")).not.toBeInTheDocument();
});
