// The SystemOne decision port: a state plus typed questions in, typed answers
// with probabilities out. TypeSafe's Jev and Cloudflare's Clef share this
// request and response format, so callers written against `Decide` can move
// between them by swapping the adapter.

import type { Env } from "../types";

export type SystemOneChoiceQuestion = {
  type: "choice";
  instructions: unknown;
  criteria: Record<string, unknown>;
};

export type SystemOneRequest = {
  state: unknown;
  questions: Record<string, SystemOneChoiceQuestion>;
};

export type SystemOneChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type SystemOneResponse = {
  model: string;
  answers: Record<string, SystemOneChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

export type Decide = (request: SystemOneRequest) => Promise<SystemOneResponse>;

// Pinned rather than `jev-latest`: SUGGEST_THRESHOLD was measured on this
// version, and an alias can move under it.
export const JEV_MODEL = "jev-1.13.0";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 5000;

export const typesafeDecide =
  (env: Pick<Env, "TYPESAFE_API_KEY">, fetchImpl: typeof fetch = fetch): Decide =>
  async (request) => {
    const response = await fetchImpl(TYPESAFE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: JEV_MODEL, ...request }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`TypeSafe systemone failed: ${response.status}`);
    return response.json<SystemOneResponse>();
  };
