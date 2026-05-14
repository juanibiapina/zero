import type { AgentContainer } from "./AgentContainer";

export interface Env {
  // Secrets
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_BOT_INFO: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;

  // Bindings
  KV: KVNamespace;
  AGENT_CONTAINER: DurableObjectNamespace<AgentContainer>;
}
