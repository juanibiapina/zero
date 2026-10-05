import { describe, expect, it, vi } from "vitest";

import { JEV_MODEL, typesafeDecide, type SystemOneRequest } from "./system-one";

const request: SystemOneRequest = {
  state: { draft_task: "buy grout" },
  questions: { project: { type: "choice", instructions: "Which project?", criteria: { p1: "Bathroom", none: "None" } } },
};

describe("typesafeDecide", () => {
  it("sends the request to Jev with the key and the pinned model", async () => {
    const answer = { model: JEV_MODEL, answers: {}, usage: { input_tokens: 10, output_tokens: 0 } };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(answer));

    expect(await typesafeDecide({ TYPESAFE_API_KEY: "key" }, fetchImpl)(request)).toEqual(answer);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer key");
    expect(JSON.parse(init?.body as string)).toEqual({ model: JEV_MODEL, ...request });
  });

  it("throws on a failed response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("slow down", { status: 429 }));

    await expect(typesafeDecide({ TYPESAFE_API_KEY: "key" }, fetchImpl)(request)).rejects.toThrow("429");
  });
});
