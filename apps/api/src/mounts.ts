// All R2 mounts the container needs to bring up.
//
// The sessions mount uses the shared Zero-managed R2 bucket, scoped by
// clerkUserId prefix. Notes are no longer FUSE-mounted; they use archive
// snapshots mediated by the worker's R2 binding (see AgentContainer.ts).

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
  ];
};
