/**
 * ============================================================================
 * SettingsService — User settings management
 * ============================================================================
 *
 * Orchestrates user settings CRUD via UserDO.
 * Routes instantiate this with the authenticated user's ID and delegate.
 */

import { Result } from "@praha/byethrow";
import type { Env } from "../types";
import type { UserDO } from "../UserDO";
import type { ServiceError } from "../lib/result";
import { DEFAULT_USER_SETTINGS, type UserSettings } from "@zero/core";

/** Keys that can be stored in user_settings. */
const KNOWN_KEYS = new Set<string>(Object.keys(DEFAULT_USER_SETTINGS));

export class SettingsService {
  constructor(
    private env: Env,
    private callerId: string,
  ) {}

  // ── Private helpers ────────────────────────────────────────────────────

  private async getUserDO(): Promise<DurableObjectStub<UserDO>> {
    const userDOIdStr = await this.env.KV.get(`user:${this.callerId}`);
    if (!userDOIdStr) {
      throw new Error("User not found in KV");
    }
    return this.env.USER_DO.get(
      this.env.USER_DO.idFromString(userDOIdStr),
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async getSettings(): Promise<{ settings: UserSettings }> {
    const userDO = await this.getUserDO();
    const stored = await userDO.getAllUserSettings();
    return {
      settings: {
        ...DEFAULT_USER_SETTINGS,
        ...Object.fromEntries(
          Object.entries(stored).filter(([k]) => KNOWN_KEYS.has(k)),
        ),
      } as UserSettings,
    };
  }

  async updateSetting(
    key: string,
    value: string,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID">>> {
    if (!KNOWN_KEYS.has(key)) {
      return Result.fail({ message: `Unknown setting: ${key}`, code: "INVALID" });
    }
    if (!value) {
      return Result.fail({ message: "Setting value cannot be empty", code: "INVALID" });
    }

    const userDO = await this.getUserDO();
    await userDO.setUserSetting(key, value);
    return Result.succeed({ success: true });
  }
}
