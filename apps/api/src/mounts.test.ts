import { describe, expect, it } from "vitest";

import { resolveMounts } from "./mounts";
import type { R2TempCreds } from "./r2-temp-credentials";
import type { Env } from "./types";

describe("resolveMounts", () => {
  it("returns the sessions mount for a user", async () => {
    const env = {
      R2_ACCOUNT_ID: "acc123",
      R2_BUCKET_NAME: "zero-agent-state",
    } as unknown as Env;
    const creds: R2TempCreds = {
      accessKeyId: "key",
      secretAccessKey: "secret",
      sessionToken: "token",
    };

    const mounts = await resolveMounts(env, "user_abc", creds);

    expect(mounts).toEqual([
      {
        name: "agent-state",
        mountPoint: "/mnt/agent-state",
        endpoint: "https://acc123.r2.cloudflarestorage.com",
        bucket: "zero-agent-state",
        prefix: "user_abc/sessions",
        accessKeyId: "key",
        secretAccessKey: "secret",
        sessionToken: "token",
      },
    ]);
  });
});
