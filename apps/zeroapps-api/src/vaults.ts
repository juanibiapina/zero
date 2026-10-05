/**
 * ============================================================================
 * Vault Accessors
 * ============================================================================
 *
 * The single seams that resolve a Durable Object stub from request context.
 * Routes call these instead of touching the DO namespaces directly.
 *
 * - OrgDO is keyed by `orgId` (the org's project registry + key ring).
 * - ProjectVaultDO is keyed by `${orgId}:${projectName}` (one vault per
 *   project). Clerk `org_...` ids contain no `:`, so the composite key is
 *   unambiguous.
 *
 * DOs never call each other — cross-DO orchestration lives in the routes.
 */

import type { Context } from "hono";
import type { Env } from "./types";
import type { OrgDO } from "./OrgDO";
import type { ProjectVaultDO } from "./ProjectVaultDO";

type Ctx = Context<{ Bindings: Env; Variables: { userId: string; orgId: string } }>;

export const getOrgVault = (c: Ctx): DurableObjectStub<OrgDO> =>
  c.env.ORGDO.get(c.env.ORGDO.idFromName(c.get("orgId")));

export const getProjectVault = (
  c: Ctx,
  name: string,
): DurableObjectStub<ProjectVaultDO> =>
  c.env.PROJECTVAULTDO.get(
    c.env.PROJECTVAULTDO.idFromName(`${c.get("orgId")}:${name}`),
  );
