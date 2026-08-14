/**
 * ============================================================================
 * CI tokens — signed, not stored
 * ============================================================================
 *
 * The credential a GitHub Actions job gets after it exchanges its OIDC token.
 *
 * The first version stored a random token in KV and read it back on the next
 * request. That failed in production: KV is eventually consistent, and a job
 * uses its token milliseconds after the exchange writes it, so the read can
 * miss and the request fails with "Invalid API key".
 *
 * A signed token removes the read. The token carries the org, the repository
 * id, and an expiry, plus an HMAC over all three. Verification is local, so
 * there is no window in which a valid token looks invalid.
 *
 * The cost is that a signed token cannot be revoked before it expires. The KV
 * version could not either (a TTL is not a revocation), and the lifetime is 15
 * minutes.
 */

const TOKEN_PREFIX = "zci_";

/** Domain separation: this key must never be usable for anything else. */
const HMAC_INFO = "zero-ci-token-v1";

type Payload = {
  /** org id */
  o: string;
  /** GitHub repository id */
  r: string;
  /** expiry, epoch seconds */
  e: number;
  /** random, so two tokens for one repository differ */
  n: string;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Signs and verifies CI tokens with a key derived from the vault's master key.
 * The derivation keeps this key separate from the encryption key: the same
 * secret material, but a compromise of one does not hand over the other.
 */
export function createCiTokenSigner(masterKey: string) {
  let keyPromise: Promise<CryptoKey> | null = null;

  const hmacKey = () => {
    keyPromise ??= (async () => {
      const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(masterKey),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: new TextEncoder().encode(HMAC_INFO),
        },
        material,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    })();
    return keyPromise;
  };

  return {
    async mint(input: { orgId: string; repoId: string; ttlSeconds: number }): Promise<{
      token: string;
      expiresIn: number;
    }> {
      const payload: Payload = {
        o: input.orgId,
        r: input.repoId,
        e: Math.floor(Date.now() / 1000) + input.ttlSeconds,
        n: base64UrlEncode(crypto.getRandomValues(new Uint8Array(9))),
      };

      const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
      const signature = await crypto.subtle.sign(
        "HMAC",
        await hmacKey(),
        new TextEncoder().encode(encoded),
      );

      return {
        token: `${TOKEN_PREFIX}${encoded}.${base64UrlEncode(new Uint8Array(signature))}`,
        expiresIn: input.ttlSeconds,
      };
    },

    /** The org and user a token stands for, or null if it is not usable. */
    async verify(token: string): Promise<{ orgId: string; userId: string } | null> {
      if (!token.startsWith(TOKEN_PREFIX)) return null;

      const parts = token.slice(TOKEN_PREFIX.length).split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

      try {
        const valid = await crypto.subtle.verify(
          "HMAC",
          await hmacKey(),
          base64UrlDecode(parts[1]),
          new TextEncoder().encode(parts[0]),
        );
        if (!valid) return null;

        const payload = JSON.parse(
          new TextDecoder().decode(base64UrlDecode(parts[0])),
        ) as Payload;

        if (typeof payload.e !== "number" || payload.e * 1000 < Date.now()) return null;
        if (!payload.o || !payload.r) return null;

        return { orgId: payload.o, userId: `ci:github:${payload.r}` };
      } catch {
        return null;
      }
    },
  };
}

export type CiTokenSigner = ReturnType<typeof createCiTokenSigner>;
