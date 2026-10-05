import { z } from "zod";
import type { Env } from "./types";

export const AiUsageRangeSchema = z.enum(["24h", "7d", "30d", "90d"]);
export type AiUsageRange = z.infer<typeof AiUsageRangeSchema>;

const INTERVALS: Record<AiUsageRange, string> = {
  "24h": "INTERVAL '24' HOUR",
  "7d": "INTERVAL '7' DAY",
  "30d": "INTERVAL '30' DAY",
  "90d": "INTERVAL '90' DAY",
};

export interface UsageTotals {
  estimatedCostUsd: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  unpricedModelCalls: number;
  unpricedTokens: number;
}

export interface UserUsage extends UsageTotals {
  userId: string;
}

export interface AgentUsage extends UsageTotals {
  agent: string;
}

export interface ConversationUsage extends UsageTotals {
  conversationId: string | null;
  chatId: string | null;
  topicId: string | null;
}

export interface AdminUsageReport {
  range: AiUsageRange;
  totals: UsageTotals;
  users: UserUsage[];
}

export interface UserUsageReport {
  range: AiUsageRange;
  totals: UsageTotals;
  byAgent: AgentUsage[];
  byConversation: ConversationUsage[];
}

const AggregateRowSchema = z.object({
  estimated_cost_usd: z.coerce.number(),
  model_calls: z.coerce.number(),
  input_tokens: z.coerce.number(),
  output_tokens: z.coerce.number(),
  cache_read_tokens: z.coerce.number(),
  cache_write_5m_tokens: z.coerce.number(),
  cache_write_1h_tokens: z.coerce.number(),
  unpriced_model_calls: z.coerce.number(),
  unpriced_tokens: z.coerce.number(),
});

type AggregateRow = z.infer<typeof AggregateRowSchema>;

const UserRowSchema = AggregateRowSchema.extend({ user_id: z.string() });
const DetailRowSchema = AggregateRowSchema.extend({
  agent: z.string(),
  conversation_id: z.string(),
  chat_id: z.string(),
  topic_id: z.string(),
});

const zeroTotals = (): UsageTotals => ({
  estimatedCostUsd: 0,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  unpricedModelCalls: 0,
  unpricedTokens: 0,
});

const toTotals = (row: AggregateRow): UsageTotals => ({
  estimatedCostUsd: row.estimated_cost_usd,
  modelCalls: row.model_calls,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWrite5mTokens: row.cache_write_5m_tokens,
  cacheWrite1hTokens: row.cache_write_1h_tokens,
  unpricedModelCalls: row.unpriced_model_calls,
  unpricedTokens: row.unpriced_tokens,
});

const addTotals = (left: UsageTotals, right: UsageTotals): UsageTotals => ({
  estimatedCostUsd: left.estimatedCostUsd + right.estimatedCostUsd,
  modelCalls: left.modelCalls + right.modelCalls,
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  cacheWrite5mTokens: left.cacheWrite5mTokens + right.cacheWrite5mTokens,
  cacheWrite1hTokens: left.cacheWrite1hTokens + right.cacheWrite1hTokens,
  unpricedModelCalls: left.unpricedModelCalls + right.unpricedModelCalls,
  unpricedTokens: left.unpricedTokens + right.unpricedTokens,
});

const aggregateSql = `
  SUM(_sample_interval * double1) AS estimated_cost_usd,
  SUM(_sample_interval * double7) AS model_calls,
  SUM(_sample_interval * double2) AS input_tokens,
  SUM(_sample_interval * double3) AS output_tokens,
  SUM(_sample_interval * double4) AS cache_read_tokens,
  SUM(_sample_interval * double5) AS cache_write_5m_tokens,
  SUM(_sample_interval * double6) AS cache_write_1h_tokens,
  SUM(_sample_interval * if(blob8 = 'unpriced', double7, 0.0)) AS unpriced_model_calls,
  SUM(_sample_interval * if(blob8 = 'unpriced', double2 + double3 + double4 + double5 + double6, 0.0)) AS unpriced_tokens
`;

export const escapeSqlString = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const timeWhere = (range: AiUsageRange): string =>
  `timestamp >= NOW() - ${INTERVALS[range]} AND timestamp <= NOW()`;

const queryRows = async <T>(
  env: Env,
  sql: string,
  schema: z.ZodType<T>,
  fetchImpl: typeof fetch,
): Promise<T[]> => {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`,
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: `${sql}\nFORMAT JSONEachRow`,
    },
  );
  if (!response.ok) {
    throw new Error(`Analytics Engine SQL failed (${response.status})`);
  }
  const text = await response.text();
  if (text.trim() === "") return [];
  return text
    .trim()
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line) as unknown));
};

export const getAdminUsage = async (
  env: Env,
  range: AiUsageRange,
  fetchImpl: typeof fetch = fetch,
): Promise<AdminUsageReport> => {
  const rows = await queryRows(
    env,
    `SELECT index1 AS user_id, ${aggregateSql}
     FROM "zero-ai-usage"
     WHERE ${timeWhere(range)}
     GROUP BY index1
     ORDER BY estimated_cost_usd DESC`,
    UserRowSchema,
    fetchImpl,
  );
  const users = rows.map((row): UserUsage => ({
    userId: row.user_id,
    ...toTotals(row),
  }));
  return {
    range,
    totals: users.reduce(addTotals, zeroTotals()),
    users,
  };
};

export const getUserUsage = async (
  env: Env,
  userId: string,
  range: AiUsageRange,
  fetchImpl: typeof fetch = fetch,
): Promise<UserUsageReport> => {
  const rows = await queryRows(
    env,
    `SELECT blob3 AS agent, blob4 AS conversation_id, blob5 AS chat_id, blob6 AS topic_id, ${aggregateSql}
     FROM "zero-ai-usage"
     WHERE index1 = ${escapeSqlString(userId)} AND ${timeWhere(range)}
     GROUP BY blob3, blob4, blob5, blob6
     ORDER BY estimated_cost_usd DESC`,
    DetailRowSchema,
    fetchImpl,
  );

  const conversations = new Map<
    string,
    {
      conversationId: string | null;
      chatId: string | null;
      topicId: string | null;
      totals: UsageTotals;
    }
  >();
  const agents = new Map<string, UsageTotals>();
  for (const row of rows) {
    const totals = toTotals(row);
    agents.set(
      row.agent,
      addTotals(agents.get(row.agent) ?? zeroTotals(), totals),
    );
    const key = `${row.conversation_id}\u0000${row.chat_id}\u0000${row.topic_id}`;
    const current = conversations.get(key);
    conversations.set(key, {
      conversationId: row.conversation_id || null,
      chatId: row.chat_id || null,
      topicId: row.topic_id || null,
      totals: addTotals(current?.totals ?? zeroTotals(), totals),
    });
  }
  const byConversation = [...conversations.values()]
    .map(
      (row): ConversationUsage => ({
        conversationId: row.conversationId,
        chatId: row.chatId,
        topicId: row.topicId,
        ...row.totals,
      }),
    )
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  const byAgent = [...agents.entries()]
    .map(([agent, totals]): AgentUsage => ({ agent, ...totals }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

  return {
    range,
    totals: rows.reduce(
      (totals, row) => addTotals(totals, toTotals(row)),
      zeroTotals(),
    ),
    byAgent,
    byConversation,
  };
};
