import type { UserDO } from "./UserDO";
import type { SessionDO } from "./SessionDO";
import type { AgentContainer } from "./AgentContainer";

export interface Env {
  // Secrets
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  ENVIRONMENT: string;

  // Bindings
  KV: KVNamespace;
  SNAPSHOTS: R2Bucket;
  USER_DO: DurableObjectNamespace<UserDO>;
  SESSION_DO: DurableObjectNamespace<SessionDO>;
  AGENT_CONTAINER: DurableObjectNamespace<AgentContainer>;
}
