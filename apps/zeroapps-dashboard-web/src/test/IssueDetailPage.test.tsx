import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { IssueDetailResponse } from "@zero/errors-core";

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

vi.mock("@/products/errors/lib/api", () => ({
  getIssue: vi.fn(),
  setIssueStatus: vi.fn(),
  deleteIssue: vi.fn(),
}));

import { toast } from "@zero/ui";
import * as api from "@/products/errors/lib/api";
import IssueDetailPage from "@/products/errors/pages/IssueDetailPage";

const getIssue = vi.mocked(api.getIssue);
const deleteIssue = vi.mocked(api.deleteIssue);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const detail: IssueDetailResponse = {
  issue: {
    id: "i1",
    fingerprint: "fp1",
    project: "web",
    title: "Cannot read trip",
    level: "error",
    status: "open",
    count: 3,
    firstSeenAt: new Date("2026-07-01T10:00:00Z").toISOString(),
    lastSeenAt: new Date("2026-07-02T10:00:00Z").toISOString(),
  },
  events: [],
};

const listMarker = "issues list";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/errors/issues/i1"]}>
      <Routes>
        <Route path="/errors/issues/:id" element={<IssueDetailPage />} />
        <Route path="/errors/issues" element={<p>{listMarker}</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Render the page and open the confirm dialog from the header. */
async function openDialog() {
  renderPage();
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: detail.issue.title })).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  return screen.getByRole("alertdialog");
}

describe("IssueDetailPage delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIssue.mockResolvedValue(detail);
  });

  it("asks for confirmation, naming the issue, before calling the API", async () => {
    const dialog = await openDialog();

    expect(dialog).toHaveTextContent("Delete this issue?");
    expect(dialog).toHaveTextContent(`"${detail.issue.title}" and its stored events`);
    expect(dialog).toHaveTextContent("it comes back as a new issue");
    expect(deleteIssue).not.toHaveBeenCalled();
  });

  it("stays on the issue when the dialog is cancelled", async () => {
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(deleteIssue).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: detail.issue.title })).toBeInTheDocument();
  });

  it("deletes the issue and returns to the issues list", async () => {
    deleteIssue.mockResolvedValueOnce(undefined);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Delete issue" }));

    await waitFor(() =>
      expect(deleteIssue).toHaveBeenCalledWith(expect.any(Function), "i1"),
    );
    await waitFor(() => expect(screen.getByText(listMarker)).toBeInTheDocument());
    expect(toastSuccess).toHaveBeenCalledWith("Issue deleted");
  });

  it("keeps the dialog open on a failed delete, and reports why", async () => {
    deleteIssue.mockRejectedValueOnce(new Error("Issue not found"));
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Delete issue" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Issue not found"),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByText(listMarker)).not.toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
