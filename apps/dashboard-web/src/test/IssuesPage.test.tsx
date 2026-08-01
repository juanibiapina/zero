import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { IssueSummary } from "@zero/errors-core";

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
  listIssues: vi.fn(),
  setIssueStatus: vi.fn(),
  deleteIssue: vi.fn(),
}));

import { toast } from "@zero/ui";
import * as api from "@/products/errors/lib/api";
import IssuesPage from "@/products/errors/pages/IssuesPage";

const listIssues = vi.mocked(api.listIssues);
const deleteIssue = vi.mocked(api.deleteIssue);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

function issue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    id: "i1",
    fingerprint: "fp1",
    project: "web",
    title: "Cannot read trip",
    level: "error",
    status: "open",
    count: 3,
    firstSeenAt: new Date("2026-07-01T10:00:00Z").toISOString(),
    lastSeenAt: new Date("2026-07-02T10:00:00Z").toISOString(),
    ...overrides,
  };
}

const first = issue();
const second = issue({ id: "i2", fingerprint: "fp2", title: "Timeout" });

function renderPage() {
  return render(
    <MemoryRouter>
      <IssuesPage />
    </MemoryRouter>,
  );
}

/** Render the list and open the confirm dialog on the first issue's row. */
async function openDialog() {
  renderPage();
  await waitFor(() => expect(screen.getByText(first.title)).toBeInTheDocument());

  fireEvent.click(
    screen.getByRole("button", { name: `Delete issue ${first.title}` }),
  );
  return screen.getByRole("alertdialog");
}

function confirmButton() {
  return screen.getByRole("button", { name: "Delete issue" });
}

function cancelButton() {
  return screen.getByRole("button", { name: "Cancel" });
}

/** A promise the test resolves or rejects by hand. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("IssuesPage delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listIssues.mockResolvedValue({ issues: [first, second] });
  });

  it("asks for confirmation, naming the issue, before calling the API", async () => {
    const dialog = await openDialog();

    expect(dialog).toHaveTextContent("Delete this issue?");
    expect(dialog).toHaveTextContent(`"${first.title}" and its stored events`);
    expect(dialog).toHaveTextContent("it comes back as a new issue");
    expect(deleteIssue).not.toHaveBeenCalled();
  });

  it("starts focus on Cancel, the least destructive action", async () => {
    await openDialog();

    await waitFor(() => expect(document.activeElement).toBe(cancelButton()));
  });

  it("closes on Escape without deleting", async () => {
    await openDialog();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(deleteIssue).not.toHaveBeenCalled();
    expect(screen.getByText(first.title)).toBeInTheDocument();
  });

  it("closes on Cancel without deleting", async () => {
    await openDialog();

    fireEvent.click(cancelButton());

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(deleteIssue).not.toHaveBeenCalled();
    expect(screen.getByText(first.title)).toBeInTheDocument();
  });

  it("locks the dialog while the delete is in flight", async () => {
    const pending = deferred();
    deleteIssue.mockReturnValueOnce(pending.promise);
    await openDialog();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(deleteIssue).toHaveBeenCalledTimes(1));

    const confirm = screen.getByRole("button", { name: "Working..." });
    expect(confirm).toBeDisabled();
    expect(cancelButton()).toBeDisabled();

    fireEvent.click(confirm);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(deleteIssue).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    pending.resolve();
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
  });

  it("deletes the issue, closes, and drops the row once the list comes back", async () => {
    deleteIssue.mockResolvedValueOnce(undefined);
    listIssues.mockResolvedValueOnce({ issues: [first, second] });
    listIssues.mockResolvedValueOnce({ issues: [second] });
    await openDialog();

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(deleteIssue).toHaveBeenCalledWith(expect.any(Function), first.id),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Issue deleted");

    // reload() only bumps the hook's nonce; the refetch lands afterwards.
    await waitFor(() =>
      expect(screen.queryByText(first.title)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(second.title)).toBeInTheDocument();
  });

  it("keeps the dialog and the row on a failed delete, and reports why", async () => {
    deleteIssue.mockRejectedValueOnce(new Error("Issue not found"));
    await openDialog();

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Issue not found"),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(first.title)).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
