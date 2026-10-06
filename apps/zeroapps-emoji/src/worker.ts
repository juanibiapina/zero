import { emojiName, suggestEmoji, type Purpose } from "@zeroapps/emoji-suggest";
import { typesafeDecide, type Decide } from "@zeroapps/typesafe";

export const MAX_QUERY_LENGTH = 200;
const CACHE_SECONDS = 7 * 24 * 60 * 60;

export const PURPOSE: Purpose = {
  context: "The user describes something in a few words and wants an emoji that represents it.",
  subject: "topic",
};

export type Deps = {
  decide: (env: Env) => Decide;
  cache: () => Cache;
};

const defaultDeps: Deps = {
  decide: (env) => typesafeDecide(env.TYPESAFE_API_KEY),
  cache: () => caches.default,
};

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export const normalize = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, " ");

const log = (fields: Record<string, unknown>) => console.log({ service: "zeroapps-emoji", msg: "emoji_suggested", ...fields });

export const handleSuggest = async (
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: Deps = defaultDeps,
): Promise<Response> => {
  if (request.method !== "GET") return json({ error: "Use GET." }, 405, { Allow: "GET" });
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query) return json({ error: "Describe what you need an emoji for." }, 400);
  if (query.length > MAX_QUERY_LENGTH) {
    return json({ error: `Keep it under ${MAX_QUERY_LENGTH} characters.` }, 400);
  }

  const started = Date.now();
  const cache = deps.cache();
  const cacheKey = new Request(new URL(`/api/suggest?q=${encodeURIComponent(normalize(query))}`, url.origin));
  const hit = await cache.match(cacheKey);
  if (hit) {
    log({ cached: true, latency_ms: Date.now() - started });
    return hit;
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const [perIp, global] = await Promise.all([env.PER_IP.limit({ key: ip }), env.GLOBAL.limit({ key: "all" })]);
  if (!perIp.success || !global.success) {
    log({ cached: false, limited: perIp.success ? "global" : "ip", latency_ms: Date.now() - started });
    return json({ error: "Too many requests. Try again in a minute." }, 429, { "Retry-After": "60" });
  }

  const { emoji, inputTokens } = await suggestEmoji(deps.decide(env), { title: query, purpose: PURPOSE });
  log({ cached: false, latency_ms: Date.now() - started, input_tokens: inputTokens, count: emoji.length });
  if (inputTokens === null) return json({ error: "Couldn't suggest right now. Try again." }, 503);

  const response = json({ emoji: emoji.map((e) => ({ emoji: e, name: emojiName(e) ?? e })) }, 200, {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/suggest") return handleSuggest(request, env, ctx);
    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
