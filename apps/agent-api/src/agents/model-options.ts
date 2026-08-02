// What every LLM adapter needs to build one tagged client. Its own module so
// the adapters and the factory that picks between them do not import each
// other.

import type { Env } from "../types";
import type { AiUsageAttribution } from "./ai-usage";

// The agents that issue LLM calls. Each turn runs the interface agent (which
// may spawn research) then the writer; onboarding and admin tasks run alone.
export type AgentLabel =
  | "interface"
  | "research"
  | "learner"
  | "compaction"
  | "onboarding"
  | "admin_task";

export interface AdapterOptions {
  env: Env;
  clerkUserId: string;
  agent: AgentLabel;
  modelId: string;
  baseURL: string;
  // The `cf-aig-metadata` header value, built once by the factory.
  metadata: string;
  // Test seam: the request bytes are what the prompt cache keys on, so tests
  // assert on them by intercepting the transport. Production passes nothing.
  fetchImpl?: typeof fetch;
  attribution?: AiUsageAttribution;
}
