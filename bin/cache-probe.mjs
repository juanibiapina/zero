#!/usr/bin/env node
// Prove the prompt-cache policy against the live provider, through Zero's own
// AI Gateway. Unit tests cannot do this: the mocks implement no cache, and a
// misplaced breakpoint is silent (the request succeeds, you just pay full
// price). See docs/caching.md.
//
// Usage: CLOUDFLARE_API_TOKEN=... node bin/cache-probe.mjs [accumulate|move|static]
//
// It simulates a tool loop: each step appends ~2.8k tokens and re-sends the
// conversation. What to look for is in the last two columns.
//
//   accumulate  every markable message keeps its breakpoint  <- Zero's policy
//               cached grows every step, write stays at the step delta
//   move        one breakpoint moves to the tail each step   <- the 2026-08-02 bug
//               cached is 0 forever, write is the whole prefix every step
//   static      one breakpoint on the stable head only
//               cached is constant, write is 0, the tail is billed at full rate
//
// Costs a few cents per run.

const ACCOUNT = "4e04b64af4013414441c59014392bea0";
const GATEWAY = "zero";
const MODEL = "gpt-5.6-luna";
const STEPS = 5;

const url = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/${GATEWAY}/openai/responses`;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error("CLOUDFLARE_API_TOKEN is required");
  process.exit(1);
}

const policy = process.argv[2] ?? "accumulate";
if (!["accumulate", "move", "static"].includes(policy)) {
  console.error(`unknown policy: ${policy}`);
  process.exit(1);
}

// ~2.8k tokens each, deterministic, and distinct so no two steps share bytes.
const part = (i) =>
  Array.from(
    { length: 140 },
    (_, line) =>
      `part ${i} line ${line} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`,
  ).join("\n");

const block = (text, marked) => ({
  type: "input_text",
  text,
  ...(marked ? { prompt_cache_breakpoint: { mode: "explicit" } } : {}),
});

// Which of steps 0..n keep a breakpoint when sending step n.
const marks = (step) => {
  if (policy === "accumulate") return (i) => i <= step;
  if (policy === "move") return (i) => i === step;
  return (i) => i === 0;
};

const key = `zero:cache-probe:${policy}:${Date.now()}`;
console.log(`policy=${policy} key=${key}`);

for (let step = 0; step < STEPS; step++) {
  const marked = marks(step);
  const content = Array.from({ length: step + 1 }, (_, i) =>
    block(part(i), marked(i)),
  );
  content.push(block(`answer step ${step} with the word ok`, false));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_output_tokens: 16,
      reasoning: { effort: "none" },
      store: false,
      prompt_cache_key: key,
      prompt_cache_options: { mode: "explicit" },
      input: [{ type: "message", role: "user", content }],
    }),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    console.error(`step ${step}: HTTP ${res.status}`, json.error ?? json);
    process.exit(1);
  }
  const d = json.usage.input_tokens_details ?? {};
  console.log(
    `step ${step}: input=${json.usage.input_tokens} cached=${d.cached_tokens ?? 0} write=${d.cache_write_tokens ?? 0}`,
  );
}
