/**
 * ============================================================================
 * Template Routes
 * ============================================================================
 *
 * GET    /api/templates          — List all prompt templates
 * POST   /api/templates          — Create a prompt template
 * PATCH  /api/templates/:id      — Update a prompt template
 * DELETE /api/templates/:id      — Delete a prompt template
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";
import { TemplateService } from "../services/templates";
import { serviceResult } from "../lib/result";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
};

// ── Schemas ──────────────────────────────────────────────────────────────

const PromptTemplateSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const TemplateListResponseSchema = z.object({
  templates: z.array(PromptTemplateSchema),
});

const CreateTemplateBodySchema = z.object({
  name: z.string(),
  slug: z.string(),
  content: z.string(),
});

const UpdateTemplateBodySchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  content: z.string().optional(),
});

const TemplateIdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    description: "Template ID",
  }),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const SuccessSchema = z.object({
  success: z.boolean(),
});

const CreateTemplateResponseSchema = z.object({
  template: PromptTemplateSchema,
});

// ── Router ───────────────────────────────────────────────────────────────

export const createTemplateRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List templates ────────────────────────────────────────────────────

  const listTemplatesRoute = createRoute({
    method: "get",
    path: "/api/templates",
    tags: ["Templates"],
    summary: "List prompt templates",
    description: "Lists all prompt templates for the user.",
    responses: {
      200: {
        content: { "application/json": { schema: TemplateListResponseSchema } },
        description: "List of templates",
      },
    },
  });

  router.openapi(listTemplatesRoute, async (c) => {
    const service = new TemplateService(c.env, c.get("userId"));
    return c.json(await service.listTemplates(), 200);
  });

  // ── Create template ───────────────────────────────────────────────────

  const createTemplateRoute = createRoute({
    method: "post",
    path: "/api/templates",
    tags: ["Templates"],
    summary: "Create prompt template",
    description: "Creates a new prompt template.",
    request: {
      body: {
        content: { "application/json": { schema: CreateTemplateBodySchema } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: CreateTemplateResponseSchema } },
        description: "Template created",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Validation error",
      },
    },
  });

  router.openapi(createTemplateRoute, async (c) => {
    const { name, slug, content } = c.req.valid("json");
    const service = new TemplateService(c.env, c.get("userId"));
    const result = await service.createTemplate(name, slug, content);
    return serviceResult(c, result, 201);
  });

  // ── Update template ───────────────────────────────────────────────────

  const updateTemplateRoute = createRoute({
    method: "patch",
    path: "/api/templates/{id}",
    tags: ["Templates"],
    summary: "Update prompt template",
    description: "Updates a prompt template by ID.",
    request: {
      params: TemplateIdParamSchema,
      body: {
        content: { "application/json": { schema: UpdateTemplateBodySchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: SuccessSchema } },
        description: "Template updated",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Validation error",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Template not found",
      },
    },
  });

  router.openapi(updateTemplateRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const service = new TemplateService(c.env, c.get("userId"));
    const result = await service.updateTemplate(parseInt(id, 10), body);
    return serviceResult(c, result, 200);
  });

  // ── Delete template ───────────────────────────────────────────────────

  const deleteTemplateRoute = createRoute({
    method: "delete",
    path: "/api/templates/{id}",
    tags: ["Templates"],
    summary: "Delete prompt template",
    description: "Deletes a prompt template by ID.",
    request: {
      params: TemplateIdParamSchema,
    },
    responses: {
      200: {
        content: { "application/json": { schema: SuccessSchema } },
        description: "Template deleted",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Template not found",
      },
    },
  });

  router.openapi(deleteTemplateRoute, async (c) => {
    const { id } = c.req.valid("param");
    const service = new TemplateService(c.env, c.get("userId"));
    const result = await service.deleteTemplate(parseInt(id, 10));
    return serviceResult(c, result, 200);
  });

  return router;
};
