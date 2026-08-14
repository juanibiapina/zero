import { describe, it, expect, vi, afterEach } from "vitest";
import { ErrorsClient } from "./errors.js";
import { ApiError } from "./http.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const client = () => new ErrorsClient("https://api.zeroapps.dev", "zv_key");

describe("ErrorsClient", () => {
  it("posts a report to the ingest endpoint and returns grouping info", async () => {
    const fetchMock = stubFetch({ issueId: "iss_1", isNew: false });

    const result = await client().report({ project: "web", message: "boom" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.zeroapps.dev/errors/v1/errors");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ project: "web", message: "boom" });
    expect(result).toEqual({ issueId: "iss_1", isNew: false });
  });

  it("sends list filters as query parameters", async () => {
    const fetchMock = stubFetch({ issues: [] });

    await client().listIssues({ project: "web", status: "open" });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.zeroapps.dev/errors/v1/issues?project=web&status=open",
    );
  });

  it("omits the query string when there are no filters", async () => {
    const fetchMock = stubFetch({ issues: [] });

    await client().listIssues();

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.zeroapps.dev/errors/v1/issues");
  });

  it("reads one issue with its events", async () => {
    const fetchMock = stubFetch({ issue: { id: "iss_1" }, events: [] });

    await client().getIssue("iss_1");

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.zeroapps.dev/errors/v1/issues/iss_1");
  });

  it("patches the status when resolving", async () => {
    const fetchMock = stubFetch({ issue: { id: "iss_1", status: "resolved" } });

    await client().setIssueStatus("iss_1", "resolved");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ status: "resolved" });
  });

  it("deletes an issue and tolerates the empty 204 body", async () => {
    const fetchMock = stubFetch(null, 204);

    await expect(client().deleteIssue("iss_1")).resolves.toBeUndefined();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("DELETE");
  });

  it("surfaces a 404 as an ApiError carrying the status", async () => {
    stubFetch({ error: "Issue not found" }, 404);

    await expect(client().deleteIssue("nope")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Issue not found",
    });
    await expect(client().deleteIssue("nope")).rejects.toBeInstanceOf(ApiError);
  });
});
