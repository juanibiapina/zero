/**
 * ============================================================================
 * DO Accessor
 * ============================================================================
 *
 * The single seam that resolves the ErrorsDO stub for a request. Routes/services
 * call this instead of touching the DO namespace directly. One ErrorsDO per org,
 * keyed by orgId (same routing scheme as ZeroVault).
 */

import type { Context } from "hono";
import type { Env } from "./types";
import type { ErrorsDO } from "./ErrorsDO";

type Ctx = Context<{ Bindings: Env; Variables: { userId: string; orgId: string } }>;

export const getErrorsDO = (c: Ctx): DurableObjectStub<ErrorsDO> =>
  c.env.ERRORSDO.get(c.env.ERRORSDO.idFromName(c.get("orgId")));

export const getErrorsDOForOrg = (
  env: Env,
  orgId: string,
): DurableObjectStub<ErrorsDO> => env.ERRORSDO.get(env.ERRORSDO.idFromName(orgId));
