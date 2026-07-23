import type { ErrorsDO } from "./ErrorsDO";

export interface Env {
  ENVIRONMENT?: string;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  ERRORSDO: DurableObjectNamespace<ErrorsDO>;
  APIKEYS: KVNamespace;
  ERRORS_RATE_LIMITER: RateLimit;
}
