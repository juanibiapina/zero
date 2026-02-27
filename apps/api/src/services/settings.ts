/**
 * ============================================================================
 * SettingsService — User settings management
 * ============================================================================
 *
 * Orchestrates user settings CRUD via UserDO.
 * Routes instantiate this with the authenticated user's ID and delegate.
 *
 * Scalar settings (hotkeyPrefix) are stored as plain key/value rows.
 * Object settings (hotkeyBindings) are JSON-serialized under a single key.
 */

import { Result } from "@praha/byethrow";
import type { Env } from "../types";
import type { UserDO } from "../UserDO";
import type { ServiceError } from "../lib/result";
import { DEFAULT_USER_SETTINGS, DEFAULT_HOTKEY_BINDINGS, type UserSettings } from "@zero/core";

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

  /** Get the raw stored bindings JSON (including null entries for cleared keys). */
  async getRawBindings(): Promise<Record<string, string | null>> {
    const userDO = await this.getUserDO();
    const stored = await userDO.getAllUserSettings();
    if (!stored.hotkeyBindings) return {};
    try {
      return JSON.parse(stored.hotkeyBindings) as Record<string, string | null>;
    } catch {
      return {};
    }
  }

  async getSettings(): Promise<{ settings: UserSettings }> {
    const userDO = await this.getUserDO();
    const stored = await userDO.getAllUserSettings();

    // Parse hotkeyBindings from JSON, merge with defaults.
    // null values mean "explicitly cleared" — remove from defaults.
    const hotkeyBindings = { ...DEFAULT_HOTKEY_BINDINGS };
    if (stored.hotkeyBindings) {
      try {
        const parsed = JSON.parse(stored.hotkeyBindings) as Record<string, string | null>;
        for (const [key, value] of Object.entries(parsed)) {
          if (value === null) {
            delete hotkeyBindings[key];
          } else {
            hotkeyBindings[key] = value;
          }
        }
      } catch {
        // Ignore invalid JSON, keep defaults
      }
    }

    return {
      settings: {
        hotkeyPrefix: stored.hotkeyPrefix ?? DEFAULT_USER_SETTINGS.hotkeyPrefix,
        hotkeyBindings,
      },
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
