import { describe, it, expect, vi } from "vitest";
import { createAgentClient, type AgentStub } from "./agent-client";
import type { Env } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeStub = (handler: (req: Request) => Promise<Response>): AgentStub => ({
  fetch: handler,
});

/** Build an Env whose AGENT_CONTAINER.getByName returns a fresh stub each call. */
const fakeEnv = (getStub: () => AgentStub): Env =>
  ({
    AGENT_CONTAINER: { getByName: () => getStub() },
  }) as unknown as Env;

/** Shorthand when a single stub is fine for all attempts. */
const staticEnv = (stub: AgentStub): Env => fakeEnv(() => stub);

/** Create an error with the .retryable flag (as Cloudflare DO infra produces). */
const retryableError = (msg = "DO reset") => {
  const err = new Error(msg);
  (err as Error & { retryable: boolean }).retryable = true;
  return err;
};

/** Create an error with the .overloaded flag. */
const overloadedError = (msg = "DO overloaded") => {
  const err = new Error(msg);
  (err as Error & { overloaded: boolean }).overloaded = true;
  return err;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentClient", () => {
  describe("sendMessage", () => {
    it("returns ok on 202", async () => {
      const stub = fakeStub(async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.includes("/messages")) {
          return new Response(null, { status: 202 });
        }
        return new Response("bad", { status: 500 });
      });
      const agent = createAgentClient(staticEnv(stub), "user_1");

      const result = await agent.sendMessage("sess-1", "hello");
      expect(result.kind).toBe("ok");
    });

    it("returns stale on 404", async () => {
      const stub = fakeStub(async () =>
        Response.json({ error: "not found" }, { status: 404 }),
      );
      const agent = createAgentClient(staticEnv(stub), "user_1");

      const result = await agent.sendMessage("sess-1", "hello");
      expect(result.kind).toBe("stale");
    });

    it("returns error on 500", async () => {
      const stub = fakeStub(async () =>
        Response.json({ error: "boom" }, { status: 500 }),
      );
      const agent = createAgentClient(staticEnv(stub), "user_1");

      const result = await agent.sendMessage("sess-1", "hello");
      expect(result).toEqual({ kind: "error", status: 500 });
    });

    it("posts base64-encoded attachments in the body", async () => {
      let captured: unknown;
      const stub = fakeStub(async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.includes("/messages")) {
          captured = await req.json();
          return new Response(null, { status: 202 });
        }
        return new Response("bad", { status: 500 });
      });
      const agent = createAgentClient(staticEnv(stub), "user_1");

      const data = new Uint8Array([1, 2, 3, 4]);
      const result = await agent.sendMessage("sess-1", "caption", [
        { filename: "a.bin", mimeType: "application/octet-stream", data },
      ]);

      expect(result.kind).toBe("ok");
      expect(captured).toEqual({
        text: "caption",
        attachments: [
          {
            filename: "a.bin",
            mimeType: "application/octet-stream",
            dataBase64: btoa(String.fromCharCode(1, 2, 3, 4)),
          },
        ],
      });
    });

    it("omits attachments key when none provided", async () => {
      let captured: unknown;
      const stub = fakeStub(async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.includes("/messages")) {
          captured = await req.json();
          return new Response(null, { status: 202 });
        }
        return new Response("bad", { status: 500 });
      });
      const agent = createAgentClient(staticEnv(stub), "user_1");

      await agent.sendMessage("sess-1", "hello");
      expect(captured).toEqual({ text: "hello" });
    });
  });

  describe("createSession", () => {
    it("returns ok with sessionId", async () => {
      const stub = fakeStub(async (req) => {
        if (req.method === "POST" && new URL(req.url).pathname === "/sessions") {
          return Response.json({ sessionId: "new-sess" });
        }
        return new Response("bad", { status: 500 });
      });
      const agent = createAgentClient(staticEnv(stub), "user_1");

      const result = await agent.createSession();
      expect(result).toEqual({ kind: "ok", sessionId: "new-sess" });
    });
  });

  describe("stub caching", () => {
    it("reuses the same stub across successful calls", async () => {
      const getByName = vi.fn(() =>
        fakeStub(async (req) => {
          const url = new URL(req.url);
          if (req.method === "POST" && url.pathname === "/sessions") {
            return Response.json({ sessionId: "s1" });
          }
          if (req.method === "POST" && url.pathname.includes("/messages")) {
            return new Response(null, { status: 202 });
          }
          return new Response("bad", { status: 500 });
        }),
      );
      const env = { AGENT_CONTAINER: { getByName } } as unknown as Env;
      const agent = createAgentClient(env, "user_1");

      await agent.createSession();
      await agent.sendMessage("s1", "hello");
      // Only called once at construction, not per method call
      expect(getByName).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry on retryable DO errors", () => {
    it("retries and succeeds on second attempt", async () => {
      let attempt = 0;
      const env = fakeEnv(() =>
        fakeStub(async (req) => {
          attempt++;
          if (attempt === 1) throw retryableError();
          if (req.method === "POST" && new URL(req.url).pathname.includes("/messages")) {
            return new Response(null, { status: 202 });
          }
          return new Response("bad", { status: 500 });
        }),
      );
      const agent = createAgentClient(env, "user_1");

      const result = await agent.sendMessage("sess-1", "hello");
      expect(result.kind).toBe("ok");
      expect(attempt).toBe(2);
    });

    it("gets a fresh stub on each retry", async () => {
      const getByName = vi.fn();
      let attempt = 0;
      getByName.mockImplementation(() =>
        fakeStub(async (req) => {
          attempt++;
          if (attempt === 1) throw retryableError();
          if (req.method === "POST" && new URL(req.url).pathname.includes("/messages")) {
            return new Response(null, { status: 202 });
          }
          return new Response("bad", { status: 500 });
        }),
      );
      const env = { AGENT_CONTAINER: { getByName } } as unknown as Env;
      const agent = createAgentClient(env, "user_1");

      await agent.sendMessage("sess-1", "hello");
      expect(getByName).toHaveBeenCalledTimes(2);
    });

    it("throws after max attempts exhausted", async () => {
      const env = fakeEnv(() =>
        fakeStub(async () => {
          throw retryableError();
        }),
      );
      const agent = createAgentClient(env, "user_1");

      await expect(agent.sendMessage("sess-1", "hello")).rejects.toThrow("DO reset");
    });
  });

  describe("overloaded DO errors", () => {
    it("does not retry on overloaded", async () => {
      let attempts = 0;
      const env = fakeEnv(() =>
        fakeStub(async () => {
          attempts++;
          throw overloadedError();
        }),
      );
      const agent = createAgentClient(env, "user_1");

      await expect(agent.sendMessage("sess-1", "hello")).rejects.toThrow("DO overloaded");
      expect(attempts).toBe(1);
    });
  });

  describe("non-retryable errors", () => {
    it("throws immediately without retry", async () => {
      let attempts = 0;
      const env = fakeEnv(() =>
        fakeStub(async () => {
          attempts++;
          throw new Error("some other error");
        }),
      );
      const agent = createAgentClient(env, "user_1");

      await expect(agent.sendMessage("sess-1", "hello")).rejects.toThrow("some other error");
      expect(attempts).toBe(1);
    });
  });
});
