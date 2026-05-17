// Resolves the notes-vault mount spec for a given user.
//
// Today there is exactly one implementation (Zero-managed R2 prefix).
// When user-configured mounts ship, this function's body grows an
// `if (await env.KV.get(...))` branch; no caller changes.
//
// The S3 shape is generic on purpose — `tigrisfs` in the container will
// mount any S3-compatible endpoint, so a future "bring your own bucket"
// provider just supplies a different endpoint + creds.

import type { R2TempCreds } from "./r2-temp-credentials";
import type { Env } from "./types";

export interface NotesMountSpec {
  endpoint: string;
  bucket: string;
  /** Prefix inside the bucket; serves as the FUSE root for tigrisfs. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/**
 * Default provider returns a Zero-managed prefix on the shared
 * `zero-agent-state` bucket. Reuses the same prefix-scoped temp
 * credentials the caller already minted for `<clerkUserId>/` — the
 * `<clerkUserId>/notes/` prefix is covered by them.
 */
export const resolveNotesMount = async (
  env: Env,
  clerkUserId: string,
  defaultR2Creds: R2TempCreds,
): Promise<NotesMountSpec> => ({
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  bucket: env.R2_BUCKET_NAME,
  prefix: `${clerkUserId}/notes`,
  accessKeyId: defaultR2Creds.accessKeyId,
  secretAccessKey: defaultR2Creds.secretAccessKey,
  sessionToken: defaultR2Creds.sessionToken,
});
