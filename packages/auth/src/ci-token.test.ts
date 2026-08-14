import { describe, expect, it } from "vitest";
import { createCiTokenSigner } from "./ci-token";

const MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const OTHER_KEY = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=";

const signer = createCiTokenSigner(MASTER_KEY);

describe("createCiTokenSigner", () => {
  it("mints a token that verifies to the org it was minted for", async () => {
    const { token } = await signer.mint({ orgId: "org_1", repoId: "777", ttlSeconds: 900 });

    expect(token).toMatch(/^zci_/);
    await expect(signer.verify(token)).resolves.toEqual({
      orgId: "org_1",
      userId: "ci:github:777",
    });
  });

  it("reports the lifetime it granted", async () => {
    const { expiresIn } = await signer.mint({ orgId: "org_1", repoId: "777", ttlSeconds: 900 });

    expect(expiresIn).toBe(900);
  });

  it("rejects a token signed with a different master key", async () => {
    const { token } = await createCiTokenSigner(OTHER_KEY).mint({
      orgId: "org_1",
      repoId: "777",
      ttlSeconds: 900,
    });

    await expect(signer.verify(token)).resolves.toBeNull();
  });

  it("rejects a token whose payload was edited to another org", async () => {
    const { token } = await signer.mint({ orgId: "org_1", repoId: "777", ttlSeconds: 900 });
    const [payload, signature] = token.slice(4).split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...decoded, o: "org_victim" })).toString(
      "base64url",
    );

    await expect(signer.verify(`zci_${forged}.${signature}`)).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    const { token } = await signer.mint({ orgId: "org_1", repoId: "777", ttlSeconds: -1 });

    await expect(signer.verify(token)).resolves.toBeNull();
  });

  it("rejects malformed input rather than throwing", async () => {
    for (const bad of ["zci_", "zci_only-payload", "zci_a.b.c", "zv_key", "", "zci_!!.??"]) {
      await expect(signer.verify(bad)).resolves.toBeNull();
    }
  });

  it("never repeats a token, so two jobs are distinguishable in logs", async () => {
    const first = await signer.mint({ orgId: "org_1", repoId: "777", ttlSeconds: 900 });
    const second = await signer.mint({ orgId: "org_1", repoId: "777", ttlSeconds: 900 });

    expect(first.token).not.toBe(second.token);
  });
});
