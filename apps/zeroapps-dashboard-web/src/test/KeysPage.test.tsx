import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";

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

vi.mock("@/account/lib/api", () => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

import { toast } from "@zero/ui";
import * as api from "@/account/lib/api";
import KeysPage from "@/account/pages/KeysPage";

const listApiKeys = vi.mocked(api.listApiKeys);
const createApiKey = vi.mocked(api.createApiKey);
const revokeApiKey = vi.mocked(api.revokeApiKey);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const loadingSecrets = "https://docs.zeroapps.dev/vault/loading-secrets/";
const sendingErrors = "https://docs.zeroapps.dev/errors/getting-started/";

function renderPage() {
  return render(
    <MemoryRouter>
      <KeysPage />
    </MemoryRouter>,
  );
}

function writeText() {
  const spy = vi.fn(() => Promise.resolve());
  // jsdom ships no clipboard.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: spy },
    configurable: true,
  });
  return spy;
}

async function createKey(key = "zv_live_secret") {
  createApiKey.mockResolvedValueOnce({
    id: 1,
    key,
    prefix: "zv_li",
    suffix: "cret",
    createdAt: new Date().toISOString(),
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(screen.getByText(key)).toBeInTheDocument());
}

describe("KeysPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listApiKeys.mockResolvedValue({ keys: [] });
  });

  it("points the empty state at both products' docs", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No API keys yet/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "loading secrets" })).toHaveAttribute(
      "href",
      loadingSecrets,
    );
    expect(screen.getByRole("link", { name: "sending errors" })).toHaveAttribute(
      "href",
      sendingErrors,
    );
  });

  it("says a key covers both products", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(
          "Keys belong to your organization. One key authorizes both Vault and Errors.",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("reveals a new key once, with both products' docs, and clears it on Dismiss", async () => {
    renderPage();
    await waitFor(() => expect(listApiKeys).toHaveBeenCalled());

    await createKey();

    expect(screen.getByRole("link", { name: "load secrets" })).toHaveAttribute(
      "href",
      loadingSecrets,
    );
    expect(screen.getByRole("link", { name: "send error reports" })).toHaveAttribute(
      "href",
      sendingErrors,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("zv_live_secret")).not.toBeInTheDocument();
  });

  it("announces the reveal and lands focus on the copy button", async () => {
    renderPage();
    await waitFor(() => expect(listApiKeys).toHaveBeenCalled());

    await createKey();

    const copy = screen.getByRole("button", { name: "Copy API key" });
    expect(screen.getByRole("status")).toContainElement(copy);
    expect(document.activeElement).toBe(copy);
  });

  it("copies the revealed key to the clipboard", async () => {
    const spy = writeText();
    renderPage();
    await waitFor(() => expect(listApiKeys).toHaveBeenCalled());

    await createKey();
    fireEvent.click(screen.getByRole("button", { name: "Copy API key" }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith("zv_live_secret"));
  });

  it("names the label input", async () => {
    renderPage();
    await waitFor(() => expect(listApiKeys).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Key label"), { target: { value: "ci" } });

    await createKey();
    expect(createApiKey).toHaveBeenCalledWith(expect.any(Function), "ci");
  });

  it("shows None for an unlabelled key and names its revoke button", async () => {
    listApiKeys.mockResolvedValue({
      keys: [
        { id: 7, prefix: "zv_ab", suffix: "cd12", createdAt: new Date().toISOString() },
      ],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("None")).toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Revoke key zv_abcd12" }),
    ).toBeInTheDocument();
  });

  it("shows the error with a Retry that recovers when the load fails", async () => {
    listApiKeys.mockRejectedValueOnce(new Error("boom"));
    renderPage();

    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());

    listApiKeys.mockResolvedValueOnce({ keys: [] });
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(screen.getByText(/No API keys yet/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });
});

const firstKey = {
  id: 7,
  prefix: "zv_ab",
  suffix: "cd12",
  label: "ci",
  createdAt: new Date("2026-07-01").toISOString(),
};
const secondKey = {
  id: 8,
  prefix: "zv_ef",
  suffix: "gh34",
  label: "prod",
  createdAt: new Date("2026-07-02").toISOString(),
};

/** Render the list and open the confirm dialog on the first key's row. */
async function openDialog() {
  renderPage();
  await waitFor(() => expect(screen.getByText(firstKey.label)).toBeInTheDocument());

  fireEvent.click(
    screen.getByRole("button", {
      name: `Revoke key ${firstKey.prefix}${firstKey.suffix}`,
    }),
  );
  return screen.getByRole("alertdialog");
}

function confirmButton() {
  return screen.getByRole("button", { name: "Revoke key" });
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

describe("KeysPage revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listApiKeys.mockResolvedValue({ keys: [firstKey, secondKey] });
  });

  it("asks for confirmation, naming the key, before calling the API", async () => {
    const dialog = await openDialog();

    expect(dialog).toHaveTextContent("Revoke this API key?");
    expect(dialog).toHaveTextContent(
      `Key ${firstKey.prefix}${firstKey.suffix} stops working immediately`,
    );
    expect(dialog).toHaveTextContent("needs a new key");
    expect(revokeApiKey).not.toHaveBeenCalled();
  });

  it("closes on Cancel without revoking", async () => {
    await openDialog();

    fireEvent.click(cancelButton());

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(revokeApiKey).not.toHaveBeenCalled();
    expect(screen.getByText(firstKey.label)).toBeInTheDocument();
  });

  it("revokes the key, closes, and drops the row once the list comes back", async () => {
    revokeApiKey.mockResolvedValueOnce(undefined);
    listApiKeys.mockResolvedValueOnce({ keys: [firstKey, secondKey] });
    listApiKeys.mockResolvedValueOnce({ keys: [secondKey] });
    await openDialog();

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(revokeApiKey).toHaveBeenCalledWith(expect.any(Function), firstKey.id),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(toastSuccess).toHaveBeenCalledWith("API key revoked");

    // reload() only bumps the hook's nonce; the refetch lands afterwards.
    await waitFor(() =>
      expect(screen.queryByText(firstKey.label)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(secondKey.label)).toBeInTheDocument();
  });

  it("keeps the dialog and the row on a failed revoke, and reports why", async () => {
    revokeApiKey.mockRejectedValueOnce(new Error("Key not found"));
    await openDialog();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Key not found"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(firstKey.label)).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("locks the dialog while the revoke is in flight", async () => {
    const pending = deferred();
    revokeApiKey.mockReturnValueOnce(pending.promise);
    await openDialog();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(revokeApiKey).toHaveBeenCalledTimes(1));

    const confirm = screen.getByRole("button", { name: "Working..." });
    expect(confirm).toBeDisabled();
    expect(cancelButton()).toBeDisabled();

    fireEvent.click(confirm);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(revokeApiKey).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    pending.resolve();
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
  });
});
