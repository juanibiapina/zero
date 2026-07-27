import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("@clerk/clerk-react", () => {
  // Stable references, matching Clerk's real memoized hooks. A fresh getToken
  // each render would churn the hook's deps and refetch in a loop.
  const getToken = () => Promise.resolve("token");
  const organization = { id: "org_1" };
  return {
    useAuth: () => ({ getToken }),
    useOrganization: () => ({ organization }),
  };
});

vi.mock("@/products/vault/lib/api", () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
}));

import * as api from "@/products/vault/lib/api";
import ProjectsPage from "@/products/vault/pages/ProjectsPage";

const listProjects = vi.mocked(api.listProjects);

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectsPage />
    </MemoryRouter>,
  );
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an error with a Retry button when the load fails, not a stuck spinner", async () => {
    listProjects.mockRejectedValueOnce(new Error("No active organization"));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No active organization/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("recovers when Retry succeeds", async () => {
    listProjects.mockRejectedValueOnce(new Error("boom"));
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument(),
    );

    listProjects.mockResolvedValueOnce({ projects: [] });
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(screen.getByText(/No projects yet/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });
});
