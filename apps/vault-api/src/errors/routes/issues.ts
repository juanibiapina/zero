/**
 * ============================================================================
 * Issue Routes (read + resolve + delete)
 * ============================================================================
 *
 * Every read and write here is exposed on both /v1 (API key) and /api (Clerk
 * session), so the CLI never has to send a user to the browser. The org is
 * resolved by the app middleware; handlers only touch the org's ErrorsDO.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { toEventSummary, type IssueStatus } from "@zero/errors-core";
import type { Env } from "../types";
import { getErrorsDO } from "../vaults";

type Variables = { userId: string; orgId: string };

const patchSchema = z.object({ status: z.enum(["open", "resolved"]) });

function parseStatus(raw: string | undefined): IssueStatus | undefined {
  return raw === "open" || raw === "resolved" ? raw : undefined;
}

export const createIssuesRouter = () => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  const list = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
    const project = c.req.query("project") || undefined;
    const status = parseStatus(c.req.query("status"));
    const issues = await getErrorsDO(c).listIssues({ project, status });
    return c.json({ issues }, 200);
  };

  const remove = async (
    c: Context<{ Bindings: Env; Variables: Variables }>,
    id: string,
  ) => {
    const deleted = await getErrorsDO(c).deleteIssue(id);
    if (!deleted) {
      return c.json({ error: "Issue not found" }, 404);
    }
    return new Response(null, { status: 204 });
  };

  const setStatus = async (
    c: Context<{ Bindings: Env; Variables: Variables }>,
    id: string,
  ) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid status" }, 400);
    }

    const issue = await getErrorsDO(c).setStatus(id, parsed.data.status);
    if (!issue) {
      return c.json({ error: "Issue not found" }, 404);
    }
    return c.json({ issue }, 200);
  };

  const detail = async (
    c: Context<{ Bindings: Env; Variables: Variables }>,
    id: string,
  ) => {
    const result = await getErrorsDO(c).getIssue(id);
    if (!result) {
      return c.json({ error: "Issue not found" }, 404);
    }
    return c.json(
      { issue: result.issue, events: result.events.map(toEventSummary) },
      200,
    );
  };

  app.get("/errors/v1/issues", list);
  app.get("/api/errors/issues", list);

  app.get("/errors/v1/issues/:id", (c) => detail(c, c.req.param("id")));
  app.get("/api/errors/issues/:id", (c) => detail(c, c.req.param("id")));

  app.delete("/errors/v1/issues/:id", (c) => remove(c, c.req.param("id")));
  app.delete("/api/errors/issues/:id", (c) => remove(c, c.req.param("id")));

  app.patch("/errors/v1/issues/:id", (c) => setStatus(c, c.req.param("id")));
  app.patch("/api/errors/issues/:id", (c) => setStatus(c, c.req.param("id")));

  return app;
};
