export type SystemOneChoiceQuestion = {
  type: "choice";
  instructions: unknown;
  criteria: Record<string, unknown>;
};

export type SystemOneNoulQuestion = {
  type: "noul";
  instructions: unknown;
  criteria?: { true: string; false: string };
};

export type SystemOneQuestion = SystemOneChoiceQuestion | SystemOneNoulQuestion;

export type SystemOneRequest = {
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
};

export type SystemOneChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type SystemOneNoulAnswer = {
  type: "noul";
  noul: number;
};

export type SystemOneAnswer = SystemOneChoiceAnswer | SystemOneNoulAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

export type Decide = (request: SystemOneRequest) => Promise<SystemOneResponse>;

export const JEV_MODEL = "jev-1.13.0";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 5000;

export const typesafeDecide =
  (apiKey: string, fetchImpl: typeof fetch = fetch): Decide =>
  async (request) => {
    const response = await fetchImpl(TYPESAFE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: JEV_MODEL, ...request }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`TypeSafe systemone failed: ${response.status}`);
    return (await response.json()) as SystemOneResponse;
  };
