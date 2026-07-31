import { describe, expect, it } from "vitest";
import type { Env } from "./types";
import {
  escapeSqlString,
  getAdminUsage,
  getUserUsage,
} from "./admin-ai-usage";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "account_1",
  CLOUDFLARE_ANALYTICS_TOKEN: "token_1",
} as unknown as Env;

const row = {
  estimated_cost_usd: 1.25,
  model_calls: 3,
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 20,
  cache_write_5m_tokens: 4,
  cache_write_1h_tokens: 6,
  unpriced_model_calls: 1,
  unpriced_tokens: 7,
};

const response = (rows: unknown[], status = 200) =>
  new Response(rows.map((value) => JSON.stringify(value)).join("\n"), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Analytics Engine SQL", () => {
  it("escapes quotes and backslashes in SQL string literals", () => {
    expect(escapeSqlString("user_' OR 1=1 --\\x")).toBe(
      "'user_\\' OR 1=1 --\\\\x'",
    );
  });

  it("weights every admin aggregate and parses user rows", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_input: unknown, options?: RequestInit) => {
      init = options;
      return response([{ user_id: "user_1", ...row }]);
    }) as typeof fetch;

    const report = await getAdminUsage(env, "7d", fetchImpl);

    expect(report.users).toEqual([{ userId: "user_1", ...report.totals }]);
    const sent = init as RequestInit;
    expect(sent.headers).toMatchObject({ Authorization: "Bearer token_1" });
    expect(sent.body).toEqual(expect.stringContaining("SUM(_sample_interval * double1)"));
    expect(sent.body).toEqual(expect.stringContaining("SUM(_sample_interval * double7)"));
    expect(sent.body).toEqual(expect.stringContaining('FROM "zero-ai-usage"'));
    expect(sent.body).toEqual(expect.stringContaining("timestamp <= NOW()"));
    expect(sent.body).toEqual(expect.stringContaining("INTERVAL '7' DAY"));
    expect(sent.body).toEqual(expect.stringContaining("FORMAT JSONEachRow"));
  });

  it("groups one user's rows by agent and conversation", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_input: unknown, options?: RequestInit) => {
      init = options;
      return response([
        {
          agent: "interface",
          conversation_id: "conv_1",
          chat_id: "42",
          topic_id: "7",
          ...row,
        },
        {
          agent: "interface",
          conversation_id: "",
          chat_id: "",
          topic_id: "",
          ...row,
          estimated_cost_usd: 0.75,
        },
        {
          agent: "research",
          conversation_id: "conv_1",
          chat_id: "42",
          topic_id: "7",
          ...row,
          estimated_cost_usd: 0.5,
        },
      ]);
    }) as typeof fetch;

    const report = await getUserUsage(
      env,
      "user_' OR 1=1 --",
      "30d",
      fetchImpl,
    );

    expect(report.totals.estimatedCostUsd).toBe(2.5);
    expect(report.byAgent).toEqual([
      expect.objectContaining({ agent: "interface", estimatedCostUsd: 2, modelCalls: 6 }),
      expect.objectContaining({ agent: "research", estimatedCostUsd: 0.5, modelCalls: 3 }),
    ]);
    expect(report.byConversation[0]).toEqual(
      expect.objectContaining({ conversationId: "conv_1", estimatedCostUsd: 1.75, modelCalls: 6 }),
    );
    expect(report.byConversation[1]).toEqual(
      expect.objectContaining({ conversationId: null, chatId: null, topicId: null }),
    );
    const body = (init as RequestInit).body;
    expect(body).toEqual(expect.stringContaining("user_\\' OR 1=1 --"));
  });

  it("rejects malformed rows and Cloudflare failures", async () => {
    await expect(
      getAdminUsage(env, "24h", async () => response([{ nope: true }])),
    ).rejects.toThrow();
    await expect(
      getAdminUsage(env, "24h", async () => response([], 500)),
    ).rejects.toThrow("Analytics Engine SQL failed (500)");
  });
});
