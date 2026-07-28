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

// The page renders without AppLayout, so there is no Toaster to read from.
// Spy on the shared toast export instead.
vi.mock("@zero/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zero/ui")>()),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/products/vault/lib/api", () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
}));

import { toast } from "@zero/ui";
import * as api from "@/products/vault/lib/api";
import ProjectsPage from "@/products/vault/pages/ProjectsPage";

const listProjects = vi.mocked(api.listProjects);
const deleteProject = vi.mocked(api.deleteProject);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const first = { id: "p1", name: "acme", createdAt: new Date("2026-07-01").toISOString() };
const second = { id: "p2", name: "beta", createdAt: new Date("2026-07-02").toISOString() };

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectsPage />
    </MemoryRouter>,
  );
}

/** Render the list and open the confirm dialog on the first project's card. */
async function openDialog() {
  renderPage();
  await waitFor(() => expect(screen.getByText(first.name)).toBeInTheDocument());

  fireEvent.click(
    screen.getByRole("button", { name: `Delete project ${first.name}` }),
  );
  return screen.getByRole("alertdialog");
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

describe("ProjectsPage delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProjects.mockResolvedValue({ projects: [first, second] });
  });

  it("asks for confirmation, naming the project, before calling the API", async () => {
    const dialog = await openDialog();

    expect(dialog).toHaveTextContent("Delete this project?");
    expect(dialog).toHaveTextContent(
      `"${first.name}" and all its environments and secrets will be removed from ZeroVault`,
    );
    expect(dialog).toHaveTextContent("stops getting them");
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("closes on Cancel without deleting", async () => {
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(deleteProject).not.toHaveBeenCalled();
    expect(screen.getByText(first.name)).toBeInTheDocument();
  });

  it("deletes the project, closes, and drops the card once the list comes back", async () => {
    deleteProject.mockResolvedValueOnce(undefined);
    listProjects.mockResolvedValueOnce({ projects: [first, second] });
    listProjects.mockResolvedValueOnce({ projects: [second] });
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

    await waitFor(() =>
      expect(deleteProject).toHaveBeenCalledWith(expect.any(Function), first.name),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Project deleted");

    // reload() only bumps the hook's nonce; the refetch lands afterwards.
    await waitFor(() =>
      expect(screen.queryByText(first.name)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(second.name)).toBeInTheDocument();
  });

  it("keeps the dialog and the card on a failed delete, and reports why", async () => {
    deleteProject.mockRejectedValueOnce(new Error("Project not found"));
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Project not found"),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(first.name)).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
