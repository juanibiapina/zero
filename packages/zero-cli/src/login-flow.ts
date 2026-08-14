/**
 * ============================================================================
 * Zero CLI — the `zero login` handshake
 * ============================================================================
 *
 * Listens on loopback, sends the user to the provider, takes the code back and
 * trades it for a token pair. Everything the flow touches that is not pure
 * (the browser, the clock, the network) is injected, so the handshake is
 * testable without a browser or a real instance.
 *
 * The redirect is always `http://127.0.0.1:<port>/callback`: the provider
 * treats the port as a wildcard but not the host spelling or the path, so
 * `localhost` and any other path are rejected (measured, not assumed).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { authorizeUrl, createPkcePair, exchangeCode, type Login } from "./oauth.js";

/** How long to wait for the user to approve before giving the port back. */
const DEFAULT_TIMEOUT_MS = 300_000;

const DONE_PAGE =
  "<!doctype html><meta charset=utf-8><title>Signed in</title>" +
  "<p>Signed in to Zero. You can close this tab and return to the terminal.";

export interface LoginFlowOptions {
  issuer: string;
  clientId: string;
  /** Fixed port for the SSH-forward case; 0 (default) takes any free port. */
  port?: number;
  timeoutMs?: number;
  /** Receives the authorization URL. Real runs open a browser and print it. */
  openBrowser: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export async function runLoginFlow(options: LoginFlowOptions): Promise<Login> {
  const { issuer, clientId, port = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const { verifier, challenge } = createPkcePair();
  const state = crypto.randomBytes(16).toString("base64url");

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const boundPort = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${boundPort}/callback`;

  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Login timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    timer.unref?.();

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get("error");
      const received = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      const fail = (message: string) => {
        clearTimeout(timer);
        res.writeHead(400, { "Content-Type": "text/plain" }).end(message);
        reject(new Error(message));
      };

      if (error) {
        fail(`Authorization failed: ${error}`);
        return;
      }
      // A mismatched state means this callback did not come from the login we
      // started, so the code it carries is not ours to use.
      if (returnedState !== state) {
        fail("Authorization failed: state did not match.");
        return;
      }
      if (!received) {
        fail("Authorization failed: no code in the callback.");
        return;
      }

      clearTimeout(timer);
      res.writeHead(200, { "Content-Type": "text/html" }).end(DONE_PAGE);
      resolve(received);
    });
  });

  // The callback can fail before `code` is awaited (the browser hits the
  // listener while the browser launch is still resolving). Observing it here
  // keeps that from surfacing as an unhandled rejection.
  code.catch(() => undefined);

  try {
    await options.openBrowser(
      authorizeUrl({ issuer, clientId, redirectUri, challenge, state }),
    );
    return await exchangeCode(
      { issuer, clientId, code: await code, verifier, redirectUri },
      options.fetchImpl ?? fetch,
    );
  } finally {
    // Always give the port back: a failed attempt must not block the retry the
    // user is about to type.
    server.close();
    server.closeAllConnections?.();
  }
}
