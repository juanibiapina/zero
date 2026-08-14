/**
 * The `zero login` handshake, driven end to end with a fake browser: the
 * "browser" is a fetch of the redirect URI the CLI itself advertised, so these
 * tests prove the loopback listener, the state check and the code exchange fit
 * together — without a real Clerk instance or a real browser.
 */

import { describe, expect, it, vi } from "vitest";
import { runLoginFlow } from "./login-flow.js";

const ISSUER = "https://clerk.example.dev";
const CLIENT_ID = "client_123";

function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.`;
}

function tokenEndpoint(claims: Record<string, unknown> = { sub: "user_1", org_id: "org_1", email: "dev@example.com" }) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: "at_1",
          refresh_token: "rt_1",
          expires_in: 86399,
          id_token: idToken(claims),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
}

/** A browser that approves: follows the authorize URL's own redirect_uri. */
function approvingBrowser(code = "code_1", state?: string) {
  return async (url: string) => {
    const params = new URL(url).searchParams;
    const redirect = new URL(params.get("redirect_uri")!);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state ?? params.get("state")!);
    await fetch(redirect.toString());
  };
}

describe("runLoginFlow", () => {
  it("returns the login for the code the browser delivered", async () => {
    const fetchImpl = tokenEndpoint();

    const login = await runLoginFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      openBrowser: approvingBrowser(),
      fetchImpl: fetchImpl,
    });

    expect(login).toMatchObject({
      accessToken: "at_1",
      refreshToken: "rt_1",
      userId: "user_1",
      orgId: "org_1",
      email: "dev@example.com",
      issuer: ISSUER,
    });
  });

  it("exchanges the code against the very redirect URI it listened on", async () => {
    const fetchImpl = tokenEndpoint();
    let advertised = "";

    await runLoginFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      openBrowser: async (url) => {
        advertised = new URL(url).searchParams.get("redirect_uri")!;
        await approvingBrowser()(url);
      },
      fetchImpl: fetchImpl,
    });

    const body = new URLSearchParams(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.get("redirect_uri")).toBe(advertised);
    expect(advertised).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("honors a fixed port, which is what makes the SSH-forward path work", async () => {
    const fetchImpl = tokenEndpoint();
    let advertised = "";

    await runLoginFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      port: 8976,
      openBrowser: async (url) => {
        advertised = new URL(url).searchParams.get("redirect_uri")!;
        await approvingBrowser()(url);
      },
      fetchImpl: fetchImpl,
    });

    expect(advertised).toBe("http://127.0.0.1:8976/callback");
  });

  it("refuses a callback whose state does not match, so a stray request cannot inject a code", async () => {
    await expect(
      runLoginFlow({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        timeoutMs: 2000,
        openBrowser: approvingBrowser("code_1", "not-my-state"),
        fetchImpl: tokenEndpoint(),
      }),
    ).rejects.toThrow(/state/i);
  });

  it("surfaces an error the provider sent instead of hanging", async () => {
    await expect(
      runLoginFlow({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        timeoutMs: 2000,
        openBrowser: async (url) => {
          const params = new URL(url).searchParams;
          const redirect = new URL(params.get("redirect_uri")!);
          redirect.searchParams.set("error", "access_denied");
          redirect.searchParams.set("state", params.get("state")!);
          await fetch(redirect.toString());
        },
        fetchImpl: tokenEndpoint(),
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it("gives up rather than waiting forever when nobody approves", async () => {
    await expect(
      runLoginFlow({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        timeoutMs: 300,
        openBrowser: () => Promise.resolve(),
        fetchImpl: tokenEndpoint(),
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("frees the port after a failed attempt, so a retry is not blocked", async () => {
    const attempt = () =>
      runLoginFlow({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        port: 8987,
        timeoutMs: 300,
        openBrowser: () => Promise.resolve(),
        fetchImpl: tokenEndpoint(),
      });

    await expect(attempt()).rejects.toThrow(/timed out/i);
    await expect(attempt()).rejects.toThrow(/timed out/i);
  });

  it("tells the browser it can close the tab", async () => {
    let pageBody = "";
    await runLoginFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      openBrowser: async (url) => {
        const params = new URL(url).searchParams;
        const redirect = new URL(params.get("redirect_uri")!);
        redirect.searchParams.set("code", "code_1");
        redirect.searchParams.set("state", params.get("state")!);
        pageBody = await (await fetch(redirect.toString())).text();
      },
      fetchImpl: tokenEndpoint(),
    });

    expect(pageBody).toMatch(/close/i);
  });
});
