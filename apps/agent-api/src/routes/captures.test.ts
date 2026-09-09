import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { generateKeyBetween } from "fractional-indexing";

import type { Env } from "../types";
import type { Capture } from "../store/captures";
import { createCapturesRoutes } from "./captures";

// A well-formed UUID the client mints; the route body requires uuid shape.
const UUID_1 = "11111111-1111-4111-8111-111111111111";

// A stand-in UserDO exposing just the capture RPC surface, backed by an array.
const fakeUserDO = (seed: Capture[] = []) => {
  const captures = [...seed];
  let n = seed.length;
  return {
    addCapture(id: string, text: string): Capture {
      const existingById = captures.find((c) => c.id === id);
      if (existingById) return existingById;
      const max = captures.reduce<string | null>(
        (m, c) => (c.sortKey != null && (m == null || c.sortKey > m) ? c.sortKey : m),
        null,
      );
      const capture: Capture = {
        id,
        text,
        createdAt: new Date(1700000000000 + ++n).toISOString(),
        processedAt: null,
        showUpDate: null,
        sortKey: generateKeyBetween(max, null),
      };
      captures.push(capture);
      return capture;
    },
    listCaptures(): Capture[] {
      return captures.filter((c) => c.processedAt === null);
    },
    processCapture(id: string): Capture | null {
      const capture = captures.find((c) => c.id === id);
      if (!capture) return null;
      capture.processedAt = new Date(1700000000000).toISOString();
      return capture;
    },
    editCapture(id: string, text: string): Capture | null {
      const capture = captures.find((c) => c.id === id);
      if (!capture) return null;
      capture.text = text;
      return capture;
    },
    rescheduleCapture(id: string, showUpDate: string | null): Capture | null {
      const capture = captures.find((c) => c.id === id);
      if (!capture) return null;
      capture.showUpDate = showUpDate;
      return capture;
    },
    reorderCapture(id: string, sortKey: string): Capture | null {
      const capture = captures.find((c) => c.id === id);
      if (!capture) return null;
      capture.sortKey = sortKey;
      return capture;
    },
    unprocessCapture(id: string): Capture | null {
      const capture = captures.find((c) => c.id === id);
      if (!capture) return null;
      capture.processedAt = null;
      return capture;
    },
    _captures: captures,
  };
};

const fakeEnv = (userDO: ReturnType<typeof fakeUserDO>) =>
  ({
    USER_DO: {
      idFromName: (_name: string) => ({ toString: () => "fake-id" }),
      get: () => userDO,
    },
  }) as unknown as Env;

const buildApp = (env: Env, userId: string) => {
  const app = new OpenAPIHono<{
    Bindings: Env;
    Variables: { userId: string };
  }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", createCapturesRoutes());
  return {
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://localhost${path}`, init), env),
  };
};

describe("GET /api/captures", () => {
  it("returns the user's Captures", async () => {
    const userDO = fakeUserDO([
      {
        id: "id-1",
        text: "buy milk",
        createdAt: "2023-11-14T22:13:20.001Z",
        processedAt: null,
        showUpDate: null,
        sortKey: "a0",
      },
    ]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      captures: [
        {
          id: "id-1",
          text: "buy milk",
          createdAt: "2023-11-14T22:13:20.001Z",
          processedAt: null,
          showUpDate: null,
          sortKey: "a0",
        },
      ],
    });
  });

  it("returns an empty Captures list when there are none", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request("/api/captures");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ captures: [] });
  });
});

describe("POST /api/captures", () => {
  it("captures an item and returns it", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: UUID_1, text: "call mom" }),
    });

    expect(res.status).toBe(201);
    const body: { capture: Capture } = await res.json();
    expect(body.capture.text).toBe("call mom");
    expect(body.capture.id).toBe(UUID_1);
    expect(userDO._captures.map((c) => c.text)).toEqual(["call mom"]);
  });

  it("dedupes a replayed POST that re-sends the same id", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const send = () =>
      app.request("/api/captures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: UUID_1, text: "call mom" }),
      });

    const first: { capture: Capture } = await (await send()).json();
    const replay: { capture: Capture } = await (await send()).json();

    expect(replay.capture.id).toBe(first.capture.id);
    expect(userDO._captures).toHaveLength(1);

    const captures = await (await app.request("/api/captures")).json();
    expect(captures).toEqual({ captures: [first.capture] });
  });

  it("rejects an empty text with 400", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: UUID_1, text: "" }),
    });

    expect(res.status).toBe(400);
    expect(userDO._captures).toEqual([]);
  });
});

describe("POST /api/captures/{id}/process", () => {
  it("processes a capture and returns it", async () => {
    const userDO = fakeUserDO([
      {
        id: "id-1",
        text: "buy milk",
        createdAt: "2023-11-14T22:13:20.001Z",
        processedAt: null,
        showUpDate: null,
        sortKey: "a0",
      },
    ]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1/process", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body: { capture: Capture } = await res.json();
    expect(body.capture.id).toBe("id-1");
    expect(body.capture.processedAt).toBeTruthy();
  });

  it("removes the processed capture from a following Captures list", async () => {
    const userDO = fakeUserDO([
      {
        id: "id-1",
        text: "buy milk",
        createdAt: "2023-11-14T22:13:20.001Z",
        processedAt: null,
        showUpDate: null,
        sortKey: "a0",
      },
    ]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    await app.request("/api/captures/id-1/process", { method: "POST" });
    const res = await app.request("/api/captures");

    expect(await res.json()).toEqual({ captures: [] });
  });

  it("returns 404 for an unknown id", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");

    const res = await app.request("/api/captures/nope/process", {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/captures/{id}/unprocess", () => {
  it("unprocesses a capture and returns it with processedAt cleared", async () => {
    const userDO = fakeUserDO([
      {
        id: "id-1",
        text: "buy milk",
        createdAt: "2023-11-14T22:13:20.001Z",
        processedAt: "2023-11-14T22:13:20.000Z",
        showUpDate: null,
        sortKey: "a0",
      },
    ]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1/unprocess", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body: { capture: Capture } = await res.json();
    expect(body.capture.id).toBe("id-1");
    expect(body.capture.processedAt).toBeNull();
  });

  it("returns the unprocessed capture to a following Captures list", async () => {
    const userDO = fakeUserDO([
      {
        id: "id-1",
        text: "buy milk",
        createdAt: "2023-11-14T22:13:20.001Z",
        processedAt: "2023-11-14T22:13:20.000Z",
        showUpDate: null,
        sortKey: "a0",
      },
    ]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    await app.request("/api/captures/id-1/unprocess", { method: "POST" });
    const res = await app.request("/api/captures");

    const body: { captures: Capture[] } = await res.json();
    expect(body.captures.map((c) => c.id)).toEqual(["id-1"]);
  });

  it("returns 404 for an unknown id", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");

    const res = await app.request("/api/captures/nope/unprocess", {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/captures/{id}", () => {
  const seeded = () =>
    fakeUserDO([
      {
        id: "id-1",
        text: "buy milk",
        createdAt: "2023-11-14T22:13:20.001Z",
        processedAt: null,
        showUpDate: null,
        sortKey: "a0",
      },
    ]);

  it("edits a capture's text and returns it", async () => {
    const userDO = seeded();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "buy oat milk" }),
    });

    expect(res.status).toBe(200);
    const body: { capture: Capture } = await res.json();
    expect(body.capture.id).toBe("id-1");
    expect(body.capture.text).toBe("buy oat milk");
    expect(userDO._captures[0].text).toBe("buy oat milk");
  });

  it("returns 404 for an unknown id", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");

    const res = await app.request("/api/captures/nope", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });

    expect(res.status).toBe(404);
  });

  it("rejects an empty text with 400", async () => {
    const userDO = seeded();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });

    expect(res.status).toBe(400);
    expect(userDO._captures[0].text).toBe("buy milk");
  });

  it("reschedules a capture's show-up date and returns it", async () => {
    const userDO = seeded();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showUpDate: "2099-01-01" }),
    });

    expect(res.status).toBe(200);
    const body: { capture: Capture } = await res.json();
    expect(body.capture.showUpDate).toBe("2099-01-01");
    expect(userDO._captures[0].showUpDate).toBe("2099-01-01");
    // Text untouched by a date-only update.
    expect(userDO._captures[0].text).toBe("buy milk");
  });

  it("clears a capture's show-up date with null", async () => {
    const userDO = seeded();
    userDO._captures[0].showUpDate = "2099-01-01";
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showUpDate: null }),
    });

    expect(res.status).toBe(200);
    expect(userDO._captures[0].showUpDate).toBeNull();
  });

  it("rejects a malformed show-up date with 400", async () => {
    const userDO = seeded();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showUpDate: "tomorrow" }),
    });

    expect(res.status).toBe(400);
    expect(userDO._captures[0].showUpDate).toBeNull();
  });

  it("reorders a capture's sort key and returns it", async () => {
    const userDO = seeded();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sortKey: "a5" }),
    });

    expect(res.status).toBe(200);
    const body: { capture: Capture } = await res.json();
    expect(body.capture.sortKey).toBe("a5");
    expect(userDO._captures[0].sortKey).toBe("a5");
    // Text and date untouched by a reorder-only update.
    expect(userDO._captures[0].text).toBe("buy milk");
    expect(userDO._captures[0].showUpDate).toBeNull();
  });

  it("rejects an empty sort key with 400", async () => {
    const userDO = seeded();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sortKey: "" }),
    });

    expect(res.status).toBe(400);
    // Unchanged by the rejected update (still the seeded key).
    expect(userDO._captures[0].sortKey).toBe("a0");
  });

  it("rejects a body with no fields to update with 400", async () => {
    const userDO = seeded();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/captures/id-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("returns 404 when rescheduling an unknown id", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");

    const res = await app.request("/api/captures/nope", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showUpDate: "2099-01-01" }),
    });

    expect(res.status).toBe(404);
  });
});
