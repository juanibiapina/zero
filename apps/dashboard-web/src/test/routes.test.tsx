import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactNode } from "react";

interface OrganizationState {
  isLoaded: boolean;
  organization: { id: string } | null;
}

const clerk = vi.hoisted((): { organization: OrganizationState } => ({
  organization: { isLoaded: true, organization: { id: "org_1" } },
}));

vi.mock("@clerk/react", () => {
  const getToken = () => Promise.resolve("token");
  return {
    ClerkProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    Show: ({ children }: { children: ReactNode }) => <>{children}</>,
    RedirectToSignIn: () => null,
    UserButton: () => <div data-testid="user-button" />,
    OrganizationSwitcher: () => <div data-testid="org-switcher" />,
    CreateOrganization: ({ afterCreateOrganizationUrl }: { afterCreateOrganizationUrl?: string }) => (
      <div data-testid="create-organization" data-after-url={afterCreateOrganizationUrl} />
    ),
    useAuth: () => ({ getToken }),
    useOrganization: () => clerk.organization,
  };
});

vi.mock("@/account/lib/api", () => ({
  listApiKeys: vi.fn(() => Promise.resolve({ keys: [] })),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock("@/products/vault/lib/api", () => ({
  listProjects: vi.fn(() => Promise.resolve({ projects: [] })),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
}));

vi.mock("@/products/errors/lib/api", () => ({
  listIssues: vi.fn(() => Promise.resolve({ issues: [] })),
  getIssue: vi.fn(),
  setIssueStatus: vi.fn(),
}));

import { routes } from "@/routes";

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("routes", () => {
  beforeEach(() => {
    // AuthProvider throws without a publishable key, mocked Clerk or not.
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test");
    clerk.organization = { isLoaded: true, organization: { id: "org_1" } };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves the keys page at /keys", async () => {
    renderAt("/keys");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "API keys" })).toBeInTheDocument(),
    );
  });

  it("redirects /vault/keys to /keys", async () => {
    const router = renderAt("/vault/keys");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "API keys" })).toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/keys");
  });

  it("redirects /vault/keys to /keys for a user with no active organization", async () => {
    clerk.organization = { isLoaded: true, organization: null };
    const router = renderAt("/vault/keys");

    await waitFor(() =>
      expect(screen.getByTestId("create-organization")).toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/keys");
    // The Vault shell would send the user back to /vault/projects instead.
    expect(screen.getByTestId("create-organization")).toHaveAttribute(
      "data-after-url",
      "/keys",
    );
  });

  it("offers API keys from Vault, outside the product nav", async () => {
    renderAt("/vault/projects");

    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Account" })).toBeInTheDocument(),
    );
    const account = screen.getByRole("navigation", { name: "Account" });
    expect(within(account).getByRole("link", { name: "API keys" })).toHaveAttribute(
      "href",
      "/keys",
    );

    const product = screen.getByRole("navigation", { name: "Product" });
    expect(within(product).queryByRole("link", { name: /keys/i })).not.toBeInTheDocument();
    expect(within(product).getByRole("link", { name: "Projects" })).toBeInTheDocument();
  });

  it("offers API keys from Errors too", async () => {
    renderAt("/errors/issues");

    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Account" })).toBeInTheDocument(),
    );
    const account = screen.getByRole("navigation", { name: "Account" });
    expect(within(account).getByRole("link", { name: "API keys" })).toHaveAttribute(
      "href",
      "/keys",
    );
  });

  it("reaches API keys in one tap on the mobile strip", async () => {
    renderAt("/vault/projects");

    await waitFor(() =>
      expect(
        screen.getByRole("navigation", { name: "Product and account" }),
      ).toBeInTheDocument(),
    );
    const strip = screen.getByRole("navigation", { name: "Product and account" });
    expect(within(strip).getByRole("link", { name: "API keys" })).toHaveAttribute(
      "href",
      "/keys",
    );
    expect(within(strip).getByRole("link", { name: "Projects" })).toBeInTheDocument();
  });

  it("marks the account row current on /keys and no product row", async () => {
    renderAt("/keys");

    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Account" })).toBeInTheDocument(),
    );
    const account = screen.getByRole("navigation", { name: "Account" });
    expect(within(account).getByRole("link", { name: "API keys" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    for (const product of ["Vault", "Errors"]) {
      const row = screen.getAllByRole("link", { name: product })[0];
      expect(row).not.toHaveAttribute("aria-current");
    }
  });

  it.each([
    ["/vault/projects", "/vault/projects"],
    ["/errors/issues", "/errors/issues"],
  ])("keeps the brand on %s pointing at %s", async (path, target) => {
    renderAt(path);

    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Product" })).toBeInTheDocument(),
    );
    for (const brand of screen.getAllByRole("link", { name: "Zero" })) {
      expect(brand).toHaveAttribute("href", target);
      expect(brand.querySelector("svg")).not.toBeNull();
    }
  });

  it("renders the account shell's brand with no product icon", async () => {
    renderAt("/keys");

    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Account" })).toBeInTheDocument(),
    );
    for (const brand of screen.getAllByRole("link", { name: "Zero" })) {
      expect(brand).toHaveAttribute("href", "/keys");
      expect(brand.querySelector("svg")).toBeNull();
    }
  });
});
