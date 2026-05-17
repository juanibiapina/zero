// All R2/S3 mounts the container needs to bring up.
//
// Today both mounts (sessions JSONL store, long-term notes vault) are
// Zero-managed prefixes on the shared `zero-agent-state` bucket. A
// future "bring your own bucket" provider for the notes scope would
// change only the corresponding entry's endpoint/creds/prefix; the
// entrypoint loop stays scope-agnostic.
//
// The shape was deliberately not introduced when only one adapter
// (notes) existed beyond the original hard-coded sessions mount. With
// two adapters now sharing the same shape, the interface is real and
// the entrypoint can iterate generically.

import type { R2TempCreds } from "./r2-temp-credentials";
import type { Env } from "./types";

export interface MountSpec {
  /** Stable identifier; appears in logs and pairs the mount with its consumer. */
  name: string;
  /** Absolute path inside the container; tigrisfs's FUSE mount point. */
  mountPoint: string;
  endpoint: string;
  bucket: string;
  /** Prefix inside the bucket; serves as the FUSE root for tigrisfs. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/**
 * Returns the ordered list of mounts to bring up for `clerkUserId`.
 *
 * Both mounts today share the same R2 endpoint, bucket, and minted
 * temp credential (the credential's `prefixPaths: ["<uid>/"]` covers
 * both sub-prefixes). When user-configured providers ship, the
 * affected entry simply gets a different endpoint/bucket/creds.
 */
export const resolveMounts = async (
  env: Env,
  clerkUserId: string,
  defaultR2Creds: R2TempCreds,
): Promise<MountSpec[]> => {
  const shared = {
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: env.R2_BUCKET_NAME,
    accessKeyId: defaultR2Creds.accessKeyId,
    secretAccessKey: defaultR2Creds.secretAccessKey,
    sessionToken: defaultR2Creds.sessionToken,
  };
  return [
    {
      ...shared,
      name: "agent-state",
      mountPoint: "/mnt/agent-state",
      prefix: `${clerkUserId}/sessions`,
    },
    {
      ...shared,
      name: "notes",
      mountPoint: "/mnt/notes",
      prefix: `${clerkUserId}/notes`,
    },
  ];
};
