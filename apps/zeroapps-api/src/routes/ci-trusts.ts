/**
 * ============================================================================
 * CI trust management (/vault/v1/ci/trusts + /api/vault/ci/trusts)
 * ============================================================================
 *
 * Which GitHub repositories may exchange an OIDC token for a credential in this
 * org. Authenticated like every other management route: a person or an API key
 * decides who is trusted; a workflow only ever consumes that decision at
 * `/vault/v1/ci/token`.
 *
 * Trust is recorded against GitHub's immutable numeric ids. The caller supplies
 * them (the CLI resolves `owner/repo` through GitHub, or reads them out of a
 * failing exchange), because matching on names would follow a renamed or
 * re-created repository to the wrong place.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types";

type Variables = { userId: string; orgId: string };
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** Events that hand a workflow this repo's identity while running outside code. */
const OPT_IN_EVENTS = ["pull_request", "pull_request_target", "workflow_run"];

export const createCiTrustsRouter = (env: Env) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  const org = (c: Ctx) => env.ORGDO.get(env.ORGDO.idFromName(c.get("orgId")));

  const add = async (c: Ctx) => {
    const body = await c.req
      .json<{
        ownerId?: string;
        repoId?: string;
        repository?: string;
        ref?: string;
        environment?: string;
        allowedEvents?: string[];
        label?: string;
      }>()
      .catch(() => ({}) as Record<string, never>);

    if (!body.ownerId || !body.repoId || !body.repository) {
      return c.json({ error: "ownerId, repoId and repository are required" }, 400);
    }

    const unknown = (body.allowedEvents ?? []).filter((e) => !OPT_IN_EVENTS.includes(e));
    if (unknown.length > 0) {
      // Silently accepting an unknown event would read as "allowed" while
      // allowing nothing, which is the worst way to be wrong about trust.
      return c.json(
        {
          error: `Unknown events: ${unknown.join(", ")}. Only ${OPT_IN_EVENTS.join(", ")} need opting into; every other event is allowed by default.`,
        },
        400,
      );
    }

    const result = await org(c).addCiTrust({
      orgId: c.get("orgId"),
      ownerId: body.ownerId,
      repoId: body.repoId,
      repository: body.repository,
      ref: body.ref ?? null,
      environment: body.environment ?? null,
      allowedEvents: body.allowedEvents ?? [],
      ...(body.label && { label: body.label }),
    });

    return c.json(result, 201);
  };

  const list = async (c: Ctx) => c.json({ trusts: await org(c).listCiTrusts() }, 200);

  const remove = async (c: Ctx) => {
    const id = parseInt(c.req.param("id")!, 10);
    await org(c).removeCiTrust(id, c.get("orgId"));
    return new Response(null, { status: 204 });
  };

  app.post("/vault/v1/ci/trusts", add);
  app.get("/vault/v1/ci/trusts", list);
  app.delete("/vault/v1/ci/trusts/:id", remove);

  app.post("/api/vault/ci/trusts", add);
  app.get("/api/vault/ci/trusts", list);
  app.delete("/api/vault/ci/trusts/:id", remove);

  return app;
};
