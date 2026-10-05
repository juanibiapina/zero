import { exports as SELF } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("host dispatch", () => {
  it("keeps dashboard assets and cookie-authenticated routes off the public API host", async () => {
    for (const path of ["/", "/assets/app.js", "/api/vault/projects", "/api/errors/issues", "/api/webhooks/clerk"]) {
      const response = await SELF.default.fetch(`https://api.zeroapps.dev${path}`);
      expect(response.status).toBe(404);
    }
  });

  it("routes dashboard APIs only on the dashboard host", async () => {
    const response = await SELF.default.fetch("https://dash.zeroapps.dev/api/vault/projects");
    expect(response.status).toBe(401);
  });

  it("rejects requests to the retired Vault host", async () => {
    const response = await SELF.default.fetch(
      "https://vault.apps.juanibiapina.dev/v1/projects",
    );
    expect(response.status).toBe(404);
  });
});
