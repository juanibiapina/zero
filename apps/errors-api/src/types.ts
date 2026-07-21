import type { ErrorsDO } from "./ErrorsDO";

export interface Env {
  ENVIRONMENT?: string;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  ERRORSDO: DurableObjectNamespace<ErrorsDO>;
  APIKEYS: KVNamespace;
  RATE_LIMITER: RateLimit;
}
