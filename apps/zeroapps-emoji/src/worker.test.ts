import { describe, expect, it, vi } from "vitest";
import type { Decide, SystemOneResponse } from "@zeroapps/typesafe";

import { handleSuggest, MAX_QUERY_LENGTH, type Deps } from "./worker";

const memoryCache = () => {
  const store = new Map<string, Response>();
  return {
    store,
    cache: {
      match: async (key: Request) => store.get(key.url)?.clone(),
      put: async (key: Request, response: Response) => void store.set(key.url, response),
    } as unknown as Cache,
  };
};

const limiter = (success: boolean) => ({ limit: vi.fn(async () => ({ success })) });

const env = (limits: { ip?: boolean; global?: boolean } = {}) =>
  ({
    TYPESAFE_API_KEY: "key",
    PER_IP: limiter(limits.ip ?? true),
    GLOBAL: limiter(limits.global ?? true),
  }) as unknown as Env;

const dogDecide = (): Decide =>
  vi.fn<Decide>(async (request): Promise<SystemOneResponse> => {
    const answers: SystemOneResponse["answers"] = {};
    if ("categories" in request.questions) {
      const criteria = (request.questions.categories as { criteria: Record<string, unknown> }).criteria;
      const probabilities = Object.fromEntries(Object.keys(criteria).map((k) => [k, k === "animal: mammal" ? 1 : 0]));
      answers.categories = { type: "choice", choice: "", probabilities, confidence: 1 };
      answers.categoriesReversed = answers.categories;
    } else {
      for (const [id, q] of Object.entries(request.questions)) {
        answers[id] = { type: "noul", noul: String(q.instructions).includes('"dog face"') ? 0.9 : 0.1 };
      }
    }
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 50, output_tokens: 0 } };
  });

const setup = (decide: Decide = dogDecide()) => {
  const { cache, store } = memoryCache();
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const deps: Deps = { decide: () => decide, cache: () => cache };
  const call = async (query: string, e = env(), init?: RequestInit) => {
    const response = await handleSuggest(
      new Request(`https://emoji.zeroapps.dev/api/suggest?q=${encodeURIComponent(query)}`, {
        headers: { "CF-Connecting-IP": "1.2.3.4" },
        ...init,
      }),
      e,
      ctx,
      deps,
    );
    await Promise.all(waits);
    return response;
  };
  return { call, store, decide };
};

describe("GET /api/suggest", () => {
  it("returns named emoji and caches them under the normalized query", async () => {
    const { call, store } = setup();
    const response = await call("  Get a   DOG ");

    expect(response.status).toBe(200);
    const body = await response.json<{ emoji: { emoji: string; name: string }[] }>();
    expect(body.emoji[0]).toEqual({ emoji: "🐶", name: "dog face" });
    expect([...store.keys()]).toEqual(["https://emoji.zeroapps.dev/api/suggest?q=get%20a%20dog"]);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=604800");
  });

  it("serves a cached answer without asking Jev or counting against the limits", async () => {
    const { call, decide } = setup();
    await call("get a dog");
    const limited = env({ ip: false, global: false });
    const response = await call("Get a dog", limited);

    expect(response.status).toBe(200);
    expect(decide).toHaveBeenCalledTimes(2);
    expect((limited.PER_IP as unknown as ReturnType<typeof limiter>).limit).not.toHaveBeenCalled();
  });

  it("rejects an empty or too long query", async () => {
    const { call, decide } = setup();

    expect((await call("   ")).status).toBe(400);
    expect((await call("x".repeat(MAX_QUERY_LENGTH + 1))).status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it("answers 429 when either limit is reached", async () => {
    const { call, decide } = setup();

    for (const limits of [{ ip: false }, { global: false }]) {
      const response = await call("get a dog", env(limits));
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
    }
    expect(decide).not.toHaveBeenCalled();
  });

  it("answers 503 and caches nothing when TypeSafe fails", async () => {
    const { call, store } = setup(
      vi.fn<Decide>(async () => {
        throw new Error("down");
      }),
    );
    const response = await call("get a dog");

    expect(response.status).toBe(503);
    expect(store.size).toBe(0);
  });

  it("only answers GET", async () => {
    const { call } = setup();

    expect((await call("get a dog", env(), { method: "POST" })).status).toBe(405);
  });
});
