/**
 * ============================================================================
 * TemplateService — Prompt template management
 * ============================================================================
 *
 * Orchestrates prompt template CRUD operations via UserDO.
 * Routes instantiate this with the authenticated user's ID and delegate.
 */

import { Result } from "@praha/byethrow";
import type { Env } from "../types";
import type { UserDO } from "../UserDO";
import type { ServiceError } from "../lib/result";
import type { PromptTemplate } from "@zero/core";

export class TemplateService {
  constructor(
    private env: Env,
    private callerId: string
  ) {}

  // ── Private helpers ────────────────────────────────────────────────────

  private async getUserDO(): Promise<DurableObjectStub<UserDO>> {
    const userDOIdStr = await this.env.KV.get(`user:${this.callerId}`);
    if (!userDOIdStr) {
      throw new Error("User not found in KV");
    }
    return this.env.USER_DO.get(
      this.env.USER_DO.idFromString(userDOIdStr)
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async listTemplates(): Promise<{ templates: PromptTemplate[] }> {
    const userDO = await this.getUserDO();
    const rows = await userDO.listPromptTemplates();
    return { templates: rows };
  }

  async createTemplate(
    name: string,
    slug: string,
    content: string
  ): Promise<Result.Result<{ template: PromptTemplate }, ServiceError<"INVALID">>> {
    if (!name || !slug || !content) {
      return Result.fail({
        message: "Missing required fields: name, slug, content",
        code: "INVALID",
      });
    }

    // Validate slug format: lowercase alphanumeric + hyphens
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return Result.fail({
        message: "Slug must be lowercase alphanumeric with hyphens (e.g. 'plan', 'bug-fix')",
        code: "INVALID",
      });
    }

    const userDO = await this.getUserDO();
    try {
      const template = await userDO.createPromptTemplate(name, slug, content);
      return Result.succeed({ template });
    } catch (err) {
      // SQLite unique constraint violation
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        return Result.fail({
          message: `A template with slug '${slug}' already exists`,
          code: "INVALID",
        });
      }
      throw err;
    }
  }

  async updateTemplate(
    id: number,
    fields: { name?: string; slug?: string; content?: string }
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID" | "NOT_FOUND">>> {
    if (fields.slug !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(fields.slug)) {
      return Result.fail({
        message: "Slug must be lowercase alphanumeric with hyphens",
        code: "INVALID",
      });
    }

    const userDO = await this.getUserDO();
    const existing = await userDO.getPromptTemplate(id);
    if (!existing) {
      return Result.fail({ message: "Template not found", code: "NOT_FOUND" });
    }

    try {
      await userDO.updatePromptTemplate(id, fields);
      return Result.succeed({ success: true as const });
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        return Result.fail({
          message: `A template with slug '${fields.slug}' already exists`,
          code: "INVALID",
        });
      }
      throw err;
    }
  }

  async deleteTemplate(
    id: number
  ): Promise<Result.Result<{ success: true }, ServiceError<"NOT_FOUND">>> {
    const userDO = await this.getUserDO();
    const existing = await userDO.getPromptTemplate(id);
    if (!existing) {
      return Result.fail({ message: "Template not found", code: "NOT_FOUND" });
    }
    await userDO.deletePromptTemplate(id);
    return Result.succeed({ success: true as const });
  }
}
