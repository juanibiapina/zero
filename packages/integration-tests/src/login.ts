/**
 * ============================================================================
 * Interactive Telegram Login
 * ============================================================================
 *
 * One-shot CLI: walks you through phone + SMS-code (+ 2FA password if set)
 * and prints a `TG_TEST_SESSION_STRING` to copy into Doppler. Run once
 * per test account, or whenever Telegram invalidates the session.
 *
 *   pnpm --filter @zero/integration-tests login
 *
 * Requires `TG_TEST_API_ID` and `TG_TEST_API_HASH` from the environment
 * (export them or run via `doppler run --project zero-tests --config dev
 * -- pnpm --filter @zero/integration-tests login`).
 */

import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { requireEnv } from "./env.js";

const apiId = Number(requireEnv("TG_TEST_API_ID"));
const apiHash = requireEnv("TG_TEST_API_HASH");

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () =>
    await input.text("Phone number (with country code, e.g. +14155551234): "),
  phoneCode: async () => await input.text("Login code from Telegram: "),
  password: async () =>
    await input.password("2FA password (leave empty if none): "),
  onError: (err) => console.error(err),
});

console.log("\n=== TG_TEST_SESSION_STRING (paste into Doppler zero-tests/dev) ===");
console.log(client.session.save());
console.log("===================================================================\n");

await client.disconnect();
