/**
 * ============================================================================
 * CI token exchange (POST /vault/v1/ci/token)
 * ============================================================================
 *
 * A GitHub Actions job proves who it is with the OIDC token GitHub mints for
 * it, and gets back a Zero credential that lives 15 minutes. That is how a
 * workflow reads secrets with no API key in the repository's secret store.
 *
 * This route is deliberately **unauthenticated**: its request body is the
 * credential. It must therefore be mounted before the `/vault/v1/*` auth
 * middleware, and it must not become an oracle — an untrusted repository learns
 * only that it is untrusted, plus the two ids it should be trusted by, which it
 * already knows about itself.
 */

import { createCiTokenSigner, trustAllows, type GithubActionsClaims } from "@zero/auth";
import { Hono } from "hono";
import { ciTrustIndexKey } from "../OrgDO";
import type { Env } from "../types";

/** Long enough for a slow job step, short enough that revocation is moot. */
const TOKEN_TTL_SECONDS = 900;

export type GithubTokenVerifier = (token: string) => Promise<GithubActionsClaims | null>;

export const createCiTokenRoute = (env: Env, verifyGithubToken: GithubTokenVerifier) => {
  const app = new Hono<{ Bindings: Env }>();
  const signer = createCiTokenSigner(env.MASTER_KEY);

  app.post("/vault/v1/ci/token", async (c) => {
    const body = await c.req
      .json<{ token?: string; orgId?: string }>()
      .catch((): { token?: string; orgId?: string } => ({}));

    // Unauthenticated endpoint: limit by connecting IP. Limiting by the
    // repository ids in the body would let a caller reset its own counter by
    // editing an unverified claim.
    const { success } = await env.CI_TOKEN_RATE_LIMITER.limit({
      key: c.req.header("CF-Connecting-IP") ?? "unknown",
    });
    if (!success) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429, {
        "Retry-After": "60",
      });
    }

    if (!body.token) {
      return c.json({ error: "Missing token. Send the GitHub Actions OIDC token." }, 400);
    }

    const claims = await verifyGithubToken(body.token);
    if (!claims) {
      return c.json(
        {
          error:
            "Invalid OIDC token. Request it with audience https://api.zeroapps.dev and permissions: id-token: write.",
        },
        401,
      );
    }

    const indexed = await env.APIKEYS.get(
      ciTrustIndexKey(claims.repositoryOwnerId, claims.repositoryId),
    );
    const orgIds = indexed ? (JSON.parse(indexed) as string[]) : [];

    // The ids come back so the fix is copy-paste; they are the workflow's own
    // identity, so echoing them tells the caller nothing it did not send.
    const untrusted = () =>
      c.json(
        {
          error: `Repository ${claims.repository} is not trusted. Run: zero ci trust add --repo ${claims.repository}`,
          ownerId: claims.repositoryOwnerId,
          repoId: claims.repositoryId,
        },
        403,
      );

    if (orgIds.length === 0) return untrusted();

    if (body.orgId && !orgIds.includes(body.orgId)) return untrusted();

    if (!body.orgId && orgIds.length > 1) {
      return c.json(
        {
          error:
            "Several organizations trust this repository. Name one with ZERO_ORG or the orgId field.",
          orgIds,
        },
        400,
      );
    }

    const orgId = body.orgId ?? orgIds[0];

    const org = env.ORGDO.get(env.ORGDO.idFromName(orgId));
    const trust = await org.findCiTrust(claims.repositoryOwnerId, claims.repositoryId);
    if (!trust) return untrusted();

    const decision = trustAllows(trust, claims);
    if (!decision.ok) {
      console.log({
        event: "ci.exchange_refused",
        reason: decision.reason,
        orgId,
        repository: claims.repository,
        eventName: claims.eventName,
      });
      return c.json({ error: refusalMessage(decision.reason, claims) }, 403);
    }

    // Signed, not stored: the job uses this token immediately, and a KV write
    // is not readable that fast.
    const minted = await signer.mint({
      orgId,
      repoId: claims.repositoryId,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });

    console.log({
      event: "ci.exchange_granted",
      orgId,
      repository: claims.repository,
      eventName: claims.eventName,
      ref: claims.ref,
      runId: claims.runId,
    });

    return c.json({
      accessToken: minted.token,
      expiresIn: minted.expiresIn,
      orgId,
    });
  });

  return app;
};

function refusalMessage(
  reason: "repository" | "ref" | "environment" | "event",
  claims: GithubActionsClaims,
): string {
  switch (reason) {
    case "event":
      return `The ${claims.eventName} event is not allowed for ${claims.repository}. It runs with this repository's identity on code from outside it, so it must be opted into explicitly.`;
    case "ref":
      return `Ref ${claims.ref} is not allowed for ${claims.repository}.`;
    case "environment":
      return `Environment ${claims.environment ?? "(none)"} is not allowed for ${claims.repository}.`;
    default:
      return `Repository ${claims.repository} is not trusted.`;
  }
}
