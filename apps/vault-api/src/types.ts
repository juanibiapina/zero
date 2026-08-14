import type { OrgDO } from "./OrgDO";
import type { ProjectVaultDO } from "./ProjectVaultDO";
import type { ErrorsDO } from "./errors/ErrorsDO";

export interface Env {
  ENVIRONMENT?: string;
  MASTER_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_WEBHOOK_SIGNING_SECRET: string;
  DISCORD_SIGNUP_WEBHOOK_URL: string;
  ZERO_API_KEY: string;
  ORGDO: DurableObjectNamespace<OrgDO>;
  PROJECTVAULTDO: DurableObjectNamespace<ProjectVaultDO>;
  ERRORSDO: DurableObjectNamespace<ErrorsDO>;
  APIKEYS: KVNamespace;
  VAULT_RATE_LIMITER: RateLimit;
  ERRORS_RATE_LIMITER: RateLimit;
  /**
   * Guards the unauthenticated CI exchange. Keyed by client IP: the repository
   * ids in an unverified token are attacker-chosen, so limiting by them limits
   * nothing.
   */
  CI_TOKEN_RATE_LIMITER: RateLimit;
  ASSETS: { fetch(request: Request): Promise<Response> };
}
