// Verify a Telegram Login Widget callback payload.
//
// Algorithm (https://core.telegram.org/widgets/login#checking-authorization):
//   secret_key        = SHA-256(bot_token)
//   data_check_string = entries.filter(k !== "hash").sort().map("k=v").join("\n")
//   expected          = HEX(HMAC-SHA-256(secret_key, data_check_string))
//   ok                = constant_time_equal(expected, payload.hash) &&
//                       (now - payload.auth_date) <= AUTH_MAX_AGE_SECONDS
//
// The payload is constructed and consumed in the same browser session, so
// the freshness window is tight (1h) — Telegram suggests <= 24h.

import { z } from "zod";

export const TelegramAuthPayloadSchema = z.object({
  id: z.number().int(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().url().optional(),
  auth_date: z.number().int(),
  hash: z.string().regex(/^[0-9a-fA-F]+$/),
});

export type TelegramAuthPayload = z.infer<typeof TelegramAuthPayloadSchema>;

const AUTH_MAX_AGE_SECONDS = 60 * 60;

export const verifyTelegramAuth = async (
  payload: TelegramAuthPayload,
  botToken: string,
): Promise<boolean> => {
  const now = Math.floor(Date.now() / 1000);
  if (payload.auth_date > now + 60) return false;
  if (now - payload.auth_date > AUTH_MAX_AGE_SECONDS) return false;

  const { hash, ...rest } = payload;
  const dataCheckString = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(botToken),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    secretKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(dataCheckString),
  );
  const expected = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return constantTimeEqual(expected, hash.toLowerCase());
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};
