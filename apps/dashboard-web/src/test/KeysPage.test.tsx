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

vi.mock("@/account/lib/api", () => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

import * as api from "@/account/lib/api";
import KeysPage from "@/account/pages/KeysPage";

const listApiKeys = vi.mocked(api.listApiKeys);
const createApiKey = vi.mocked(api.createApiKey);
const revokeApiKey = vi.mocked(api.revokeApiKey);

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

  it("revokes a key after confirmation and reloads the list", async () => {
    listApiKeys.mockResolvedValue({
      keys: [
        {
          id: 7,
          prefix: "zv_ab",
          suffix: "cd12",
          label: "ci",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    revokeApiKey.mockResolvedValueOnce(undefined);
    renderPage();

    await waitFor(() => expect(screen.getByText("ci")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Revoke key zv_abcd12" }));

    await waitFor(() =>
      expect(revokeApiKey).toHaveBeenCalledWith(expect.any(Function), 7),
    );
    await waitFor(() => expect(listApiKeys).toHaveBeenCalledTimes(2));
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
