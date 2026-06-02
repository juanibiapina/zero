// All R2 mounts the container needs to bring up.
//
// Both mounts (sessions, notes) use the same Zero-managed R2 bucket,
// scoped by clerkUserId prefix. The entrypoint loop stays scope-agnostic:
// it iterates MOUNT_<n>_* env groups regardless of credential source.

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
 * Both mounts use the shared R2 bucket.
 */
export const resolveMounts = async (
  env: Env,
  clerkUserId: string,
  creds: R2TempCreds,
): Promise<MountSpec[]> => {
  const shared = {
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: env.R2_BUCKET_NAME,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
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
