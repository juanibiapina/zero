import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";

const auth = vi.hoisted(() => ({ isSignedIn: true }));
vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  SignIn: () => <div>Sign in form</div>,
  UserButton: () => <div>Account</div>,
  useAuth: () => ({ isLoaded: true, isSignedIn: auth.isSignedIn, userId: auth.isSignedIn ? "A" : null }),
}));
vi.mock("./lib/todo-data", () => ({
  TodoDataProvider: ({ children }: { children: ReactNode }) => children,
  useTodoData: () => ({ sync: { phase: "synced", lastSyncedAt: null }, durable: true, durabilityError: null, authenticatedFeatures: auth.isSignedIn }),
}));
vi.mock("./lib/timezone-sync", () => ({ createWebTimezoneSync: () => ({ onColdStart: vi.fn() }) }));
vi.mock("./pages/HomePage", () => ({ HomePage: () => <div>Home task list</div> }));
vi.mock("./pages/SettingsPage", () => ({ SettingsPage: () => <div>Account settings</div> }));

beforeEach(() => {
  auth.isSignedIn = true;
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ onboardingSeen: true, googleOnboardingStatus: null, timezone: null }) }));
});
afterEach(() => vi.unstubAllGlobals());
function renderAt(path: string) { window.history.replaceState({}, "", path); render(<App />); }

it("uses /home as the Home destination", async () => {
  renderAt("/home");
  await screen.findByText("Home task list");
  expect(screen.getAllByRole("link", { name: "Home" })[0]).toHaveAttribute("href", "/home");
  expect(screen.getAllByRole("button", { name: "Synced" })).not.toHaveLength(0);
});
it("handles retired and unknown routes through Home", async () => {
  renderAt("/captures");
  await waitFor(() => expect(window.location.pathname).toBe("/home"));
  expect(screen.getByText("Home task list")).toBeInTheDocument();
});
it("opens guest Home without authenticated settings requests", async () => {
  auth.isSignedIn = false;
  renderAt("/");
  await screen.findByText("Home task list");
  expect(screen.getAllByRole("link", { name: "Sign in" })[0]).toHaveAttribute("href", "/sign-in");
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps account settings authenticated", async () => {
  auth.isSignedIn = false;
  renderAt("/settings");
  expect(await screen.findByText("Sign in form")).toBeInTheDocument();
  expect(screen.queryByText("Account settings")).toBeNull();
});
it("shows signed-in settings at their own destination", async () => {
  renderAt("/settings");
  expect(await screen.findByText("Account settings")).toBeInTheDocument();
});
it("opens todos even when account settings cannot be fetched", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
  renderAt("/home");
  expect(await screen.findByText("Home task list")).toBeInTheDocument();
});
