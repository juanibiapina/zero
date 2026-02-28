/**
 * ============================================================================
 * SettingsService — User settings management
 * ============================================================================
 *
 * Orchestrates user settings CRUD via UserDO.
 * Routes instantiate this with the authenticated user's ID and delegate.
 *
 * Each setting is stored as its own row in the user_settings KV table.
 * Hotkey bindings use the key prefix `hotkey:<actionId>`.
 * An empty string value means "explicitly cleared / unbound".
 */

import { Result } from "@praha/byethrow";
import type { Env } from "../types";
import type { UserDO } from "../UserDO";
import type { ServiceError } from "../lib/result";
import { DEFAULT_USER_SETTINGS, DEFAULT_HOTKEY_BINDINGS, APP_ACTION_IDS, THINKING_LEVELS, type UserSettings, type ThinkingLevel } from "@zero/core";

const HOTKEY_PREFIX = "hotkey:";

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

    // Build hotkey bindings: start with defaults, apply per-action overrides.
    // Missing row → use default. Empty string → explicitly unbound.
    const hotkeyBindings = { ...DEFAULT_HOTKEY_BINDINGS };
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(HOTKEY_PREFIX)) continue;
      const actionId = key.slice(HOTKEY_PREFIX.length);
      if (value === "") {
        delete hotkeyBindings[actionId];
      } else {
        hotkeyBindings[actionId] = value;
      }
    }

    return {
      settings: {
        hotkeyPrefix: stored.hotkeyPrefix ?? DEFAULT_USER_SETTINGS.hotkeyPrefix,
        hotkeyBindings,
        defaultProvider: stored.defaultProvider ?? null,
        defaultModel: stored.defaultModel ?? null,
        defaultThinkingLevel: (stored.defaultThinkingLevel as ThinkingLevel) ?? null,
      },
    };
  }

  async updateHotkeyPrefix(
    value: string,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID">>> {
    if (!value) {
      return Result.fail({ message: "Hotkey prefix cannot be empty", code: "INVALID" });
    }
    const userDO = await this.getUserDO();
    await userDO.setUserSetting("hotkeyPrefix", value);
    return Result.succeed({ success: true });
  }

  async updateHotkeyBinding(
    actionId: string,
    key: string | null,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID">>> {
    if (!APP_ACTION_IDS.has(actionId)) {
      return Result.fail({ message: `Unknown action: ${actionId}`, code: "INVALID" });
    }
    const userDO = await this.getUserDO();
    // null → explicitly cleared (store empty string sentinel)
    await userDO.setUserSetting(`${HOTKEY_PREFIX}${actionId}`, key ?? "");
    return Result.succeed({ success: true });
  }

  async updateDefaultProvider(
    value: string | null,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID">>> {
    const userDO = await this.getUserDO();
    if (value === null) {
      await userDO.deleteUserSetting("defaultProvider");
    } else {
      await userDO.setUserSetting("defaultProvider", value);
    }
    return Result.succeed({ success: true });
  }

  async updateDefaultModel(
    value: string | null,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID">>> {
    const userDO = await this.getUserDO();
    if (value === null) {
      await userDO.deleteUserSetting("defaultModel");
    } else {
      await userDO.setUserSetting("defaultModel", value);
    }
    return Result.succeed({ success: true });
  }

  async updateDefaultThinkingLevel(
    value: ThinkingLevel | null,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID">>> {
    if (value !== null && !THINKING_LEVELS.some((t) => t.id === value)) {
      return Result.fail({ message: `Invalid thinking level: ${value}`, code: "INVALID" });
    }
    const userDO = await this.getUserDO();
    if (value === null) {
      await userDO.deleteUserSetting("defaultThinkingLevel");
    } else {
      await userDO.setUserSetting("defaultThinkingLevel", value);
    }
    return Result.succeed({ success: true });
  }
}
