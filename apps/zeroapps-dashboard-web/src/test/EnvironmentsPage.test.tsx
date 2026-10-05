import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("@clerk/react", () => {
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
  listEnvironments: vi.fn(),
  createEnvironment: vi.fn(),
  deleteEnvironment: vi.fn(),
}));

import { toast } from "@zero/ui";
import * as api from "@/products/vault/lib/api";
import EnvironmentsPage from "@/products/vault/pages/EnvironmentsPage";

const listEnvironments = vi.mocked(api.listEnvironments);
const deleteEnvironment = vi.mocked(api.deleteEnvironment);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const project = "acme";
const first = {
  id: "e1",
  name: "production",
  createdAt: new Date("2026-07-01").toISOString(),
};
const second = {
  id: "e2",
  name: "staging",
  createdAt: new Date("2026-07-02").toISOString(),
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/vault/projects/${project}`]}>
      <Routes>
        <Route path="/vault/projects/:project" element={<EnvironmentsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Render the list and open the confirm dialog on the first environment's row. */
async function openDialog() {
  renderPage();
  await waitFor(() => expect(screen.getByText(first.name)).toBeInTheDocument());

  fireEvent.click(
    screen.getByRole("button", { name: `Delete environment ${first.name}` }),
  );
  return screen.getByRole("alertdialog");
}

describe("EnvironmentsPage delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listEnvironments.mockResolvedValue({ environments: [first, second] });
  });

  it("asks for confirmation, naming the environment and its project, before calling the API", async () => {
    const dialog = await openDialog();

    expect(dialog).toHaveTextContent("Delete this environment?");
    expect(dialog).toHaveTextContent(
      `"${first.name}" and all its secrets in "${project}" will be removed from ZeroVault`,
    );
    expect(dialog).toHaveTextContent("stops getting them");
    expect(deleteEnvironment).not.toHaveBeenCalled();
  });

  it("closes on Cancel without deleting", async () => {
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(deleteEnvironment).not.toHaveBeenCalled();
    expect(screen.getByText(first.name)).toBeInTheDocument();
  });

  it("deletes the environment, closes, and drops the row once the list comes back", async () => {
    deleteEnvironment.mockResolvedValueOnce(undefined);
    listEnvironments.mockResolvedValueOnce({ environments: [first, second] });
    listEnvironments.mockResolvedValueOnce({ environments: [second] });
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Delete environment" }));

    await waitFor(() =>
      expect(deleteEnvironment).toHaveBeenCalledWith(
        expect.any(Function),
        project,
        first.name,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Environment deleted");

    // reload() only bumps the hook's nonce; the refetch lands afterwards.
    await waitFor(() =>
      expect(screen.queryByText(first.name)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(second.name)).toBeInTheDocument();
  });

  it("keeps the dialog and the row on a failed delete, and reports why", async () => {
    deleteEnvironment.mockRejectedValueOnce(new Error("Environment not found"));
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Delete environment" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Environment not found"),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(first.name)).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
