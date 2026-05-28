import { describe, expect, it } from "vitest";

import { resolveMounts } from "./mounts";
import type { S3MountConfig } from "./UserDO/index";
import type { R2TempCreds } from "./r2-temp-credentials";
import type { Env } from "./types";

describe("resolveMounts", () => {
  it("returns the sessions and notes mounts for a user", async () => {
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
      {
        name: "notes",
        mountPoint: "/mnt/notes",
        endpoint: "https://acc123.r2.cloudflarestorage.com",
        bucket: "zero-agent-state",
        prefix: "user_abc/notes",
        accessKeyId: "key",
        secretAccessKey: "secret",
        sessionToken: "token",
      },
    ]);
  });

  it("uses user S3 config for notes when provided", async () => {
    const env = {
      R2_ACCOUNT_ID: "acc123",
      R2_BUCKET_NAME: "zero-agent-state",
    } as unknown as Env;
    const creds: R2TempCreds = {
      accessKeyId: "key",
      secretAccessKey: "secret",
      sessionToken: "token",
    };
    const userNotesConfig: S3MountConfig = {
      endpoint: "https://s3.my-server.com",
      bucket: "my-notes",
      prefix: "obsidian",
      accessKeyId: "user-key",
      secretAccessKey: "user-secret",
    };

    const mounts = await resolveMounts(env, "user_abc", creds, userNotesConfig);

    expect(mounts[0]).toEqual({
      name: "agent-state",
      mountPoint: "/mnt/agent-state",
      endpoint: "https://acc123.r2.cloudflarestorage.com",
      bucket: "zero-agent-state",
      prefix: "user_abc/sessions",
      accessKeyId: "key",
      secretAccessKey: "secret",
      sessionToken: "token",
    });
    expect(mounts[1]).toEqual({
      name: "notes",
      mountPoint: "/mnt/notes",
      endpoint: "https://s3.my-server.com",
      bucket: "my-notes",
      prefix: "obsidian",
      accessKeyId: "user-key",
      secretAccessKey: "user-secret",
      sessionToken: "",
    });
  });
});
