/**
 * ============================================================================
 * SecretsService — User secret management
 * ============================================================================
 *
 * Orchestrates secret CRUD operations via UserDO.
 * Routes instantiate this with the authenticated user's ID and delegate.
 */

import { Result } from "@praha/byethrow";
import type { Env } from "../types";
import type { UserDO } from "../UserDO";
import type { ServiceError } from "../lib/result";

type SecretSummary = {
  name: string;
  createdAt: string;
};

export class SecretsService {
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
    ) as DurableObjectStub<UserDO>;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async listSecrets(): Promise<Result.Result<{ secrets: SecretSummary[] }, ServiceError>> {
    const userDO = await this.getUserDO();
    const rows = await userDO.listUserSecrets();
    return Result.succeed({
      secrets: rows.map((s) => ({ name: s.name, createdAt: s.createdAt })),
    });
  }

  async upsertSecret(
    name: string,
    value: string
  ): Promise<Result.Result<{ success: true }, ServiceError>> {
    if (!name || !value) {
      return Result.fail({
        message: "Missing required fields: name, value",
        code: "INVALID",
      });
    }

    const userDO = await this.getUserDO();
    await userDO.upsertUserSecret(name, value);
    return Result.succeed({ success: true });
  }

  async deleteSecret(
    name: string
  ): Promise<Result.Result<{ success: true }, ServiceError>> {
    const userDO = await this.getUserDO();
    await userDO.deleteUserSecret(name);
    return Result.succeed({ success: true });
  }
}
