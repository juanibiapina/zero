import type { OrgDO } from "./OrgDO";
import type { ProjectVaultDO } from "./ProjectVaultDO";

export interface Env {
  ENVIRONMENT?: string;
  MASTER_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  ORGDO: DurableObjectNamespace<OrgDO>;
  PROJECTVAULTDO: DurableObjectNamespace<ProjectVaultDO>;
  APIKEYS: KVNamespace;
  RATE_LIMITER: RateLimit;
}
