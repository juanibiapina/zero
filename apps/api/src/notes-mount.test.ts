import { describe, expect, it } from "vitest";

import { resolveNotesMount } from "./notes-mount";
import type { R2TempCreds } from "./r2-temp-credentials";
import type { Env } from "./types";

describe("resolveNotesMount", () => {
  it("returns a user-scoped notes prefix on the configured R2 bucket", async () => {
    const env = {
      R2_ACCOUNT_ID: "acc123",
      R2_BUCKET_NAME: "zero-agent-state",
    } as unknown as Env;
    const creds: R2TempCreds = {
      accessKeyId: "key",
      secretAccessKey: "secret",
      sessionToken: "token",
    };

    const spec = await resolveNotesMount(env, "user_abc", creds);

    expect(spec).toEqual({
      endpoint: "https://acc123.r2.cloudflarestorage.com",
      bucket: "zero-agent-state",
      prefix: "user_abc/notes",
      accessKeyId: "key",
      secretAccessKey: "secret",
      sessionToken: "token",
    });
  });
});
