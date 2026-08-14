/**
 * ============================================================================
 * Zero CLI — GitHub Actions authentication
 * ============================================================================
 *
 * Inside a workflow, `zero` needs no API key: GitHub mints a short-lived OIDC
 * token describing the job, and Zero trades it for a credential valid for
 * fifteen minutes. Nothing is written to disk, and the repository needs no
 * secret at all.
 *
 * The two environment variables below exist only when the job declares
 * `permissions: id-token: write`, so their absence is a reliable "this job
 * cannot do CI auth" — not something to work around.
 */

/** The audience Zero requires, so a token minted for AWS cannot be replayed. */
export const ZERO_OIDC_AUDIENCE = "https://api.zeroapps.dev";

export interface ActionsEnvironment {
  requestUrl: string;
  requestToken: string;
}

/**
 * The Actions OIDC endpoint for this job, or null when there is none. Takes the
 * environment as an argument so the detection is testable without mutating the
 * process.
 */
export function actionsEnvironment(
  env: Record<string, string | undefined>,
): ActionsEnvironment | null {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;
  return { requestUrl, requestToken };
}

export async function requestOidcToken(
  actions: ActionsEnvironment,
  audience: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  // The runner's URL already carries api-version, so append rather than rebuild.
  const url = new URL(actions.requestUrl);
  url.searchParams.set("audience", audience);

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${actions.requestToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub refused to mint an OIDC token (HTTP ${response.status}). ` +
        "Does the job have `permissions: id-token: write`?",
    );
  }

  const body = (await response.json()) as { value?: string };
  if (!body.value) throw new Error("GitHub returned no OIDC token.");
  return body.value;
}

export async function exchangeCiToken(
  input: { baseUrl: string; oidcToken: string; orgId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; orgId: string }> {
  const response = await fetchImpl(`${input.baseUrl}/vault/v1/ci/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: input.oidcToken,
      ...(input.orgId && { orgId: input.orgId }),
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    accessToken?: string;
    orgId?: string;
    error?: string;
    ownerId?: string;
    repoId?: string;
  };

  if (!response.ok || !body.accessToken || !body.orgId) {
    // The server knows why, and for an untrusted repo it also knows the two ids
    // the user needs — which is the only way to trust a private repository from
    // a machine that cannot read GitHub's API.
    const ids =
      body.ownerId && body.repoId
        ? ` Trust it with: zero ci trust add --repo <owner/repo> --owner-id ${body.ownerId} --repo-id ${body.repoId}`
        : "";
    throw new Error(`${body.error ?? `HTTP ${response.status}`}.${ids}`);
  }

  return { accessToken: body.accessToken, orgId: body.orgId };
}
