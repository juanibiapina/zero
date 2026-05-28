// All R2/S3 mounts the container needs to bring up.
//
// The sessions mount always uses Zero-managed R2. The notes mount
// defaults to R2 but can be overridden per-user with an external
// S3-compatible provider (configured via the web UI, stored in UserDO).
//
// The entrypoint loop stays scope-agnostic: it iterates MOUNT_<n>_*
// env groups regardless of endpoint or credential source.
//
// The shape was deliberately not introduced when only one adapter
// (notes) existed beyond the original hard-coded sessions mount. With
// two adapters now sharing the same shape, the interface is real and
// the entrypoint can iterate generically.

import type { R2TempCreds } from "./r2-temp-credentials";
import type { S3MountConfig } from "./UserDO/index";
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
 * The sessions mount always uses the shared R2 bucket. The notes mount
 * uses `notesMountConfig` when the user has configured an external S3
 * provider, falling back to the same R2 bucket otherwise.
 */
export const resolveMounts = async (
  env: Env,
  clerkUserId: string,
  defaultR2Creds: R2TempCreds,
  notesMountConfig?: S3MountConfig | null,
): Promise<MountSpec[]> => {
  const shared = {
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: env.R2_BUCKET_NAME,
    accessKeyId: defaultR2Creds.accessKeyId,
    secretAccessKey: defaultR2Creds.secretAccessKey,
    sessionToken: defaultR2Creds.sessionToken,
  };

  const notesMountSpec: MountSpec = notesMountConfig
    ? {
        name: "notes",
        mountPoint: "/mnt/notes",
        endpoint: notesMountConfig.endpoint,
        bucket: notesMountConfig.bucket,
        prefix: notesMountConfig.prefix,
        accessKeyId: notesMountConfig.accessKeyId,
        secretAccessKey: notesMountConfig.secretAccessKey,
        sessionToken: "",
      }
    : {
        ...shared,
        name: "notes",
        mountPoint: "/mnt/notes",
        prefix: `${clerkUserId}/notes`,
      };

  return [
    {
      ...shared,
      name: "agent-state",
      mountPoint: "/mnt/agent-state",
      prefix: `${clerkUserId}/sessions`,
    },
    notesMountSpec,
  ];
};
