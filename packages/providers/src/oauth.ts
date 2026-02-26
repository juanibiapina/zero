/**
 * OAuth helpers — re-exports from pi-ai's individual OAuth modules
 * plus a unified refresh function.
 *
 * Deep imports to individual provider modules avoid the oauth/index.js barrel
 * which pulls in the http-proxy side effect.
 */

// ── Types ────────────────────────────────────────────────────────────────

export type {
  OAuthCredentials,
  OAuthProviderInterface,
  OAuthProviderId,
  OAuthLoginCallbacks,
  OAuthAuthInfo,
  OAuthPrompt,
} from "@mariozechner/pi-ai/dist/utils/oauth/types.js";

// ── PKCE ─────────────────────────────────────────────────────────────────

export { generatePKCE } from "@mariozechner/pi-ai/dist/utils/oauth/pkce.js";

// ── Anthropic ────────────────────────────────────────────────────────────

export {
  loginAnthropic,
  refreshAnthropicToken,
  anthropicOAuthProvider,
} from "@mariozechner/pi-ai/dist/utils/oauth/anthropic.js";

// ── GitHub Copilot ───────────────────────────────────────────────────────

export {
  loginGitHubCopilot,
  refreshGitHubCopilotToken,
  githubCopilotOAuthProvider,
} from "@mariozechner/pi-ai/dist/utils/oauth/github-copilot.js";

// ── OpenAI Codex ─────────────────────────────────────────────────────────

export {
  loginOpenAICodex,
  refreshOpenAICodexToken,
  openaiCodexOAuthProvider,
} from "@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js";

// ── Google Gemini CLI ────────────────────────────────────────────────────

export {
  loginGeminiCli,
  refreshGoogleCloudToken,
  geminiCliOAuthProvider,
} from "@mariozechner/pi-ai/dist/utils/oauth/google-gemini-cli.js";

// ── Google Antigravity ───────────────────────────────────────────────────

export {
  loginAntigravity,
  refreshAntigravityToken,
  antigravityOAuthProvider,
} from "@mariozechner/pi-ai/dist/utils/oauth/google-antigravity.js";

// ── Anthropic web OAuth (two-step PKCE flow) ────────────────────────────
//
// pi-ai's loginAnthropic() runs the full flow in one call (terminal use).
// For web apps we need a two-step start/complete split.  The constants below
// mirror the private values in pi-ai's anthropic.js module.

const ANTHROPIC_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scopes: "org:create_api_key user:profile user:inference",
};

/**
 * Build the Anthropic OAuth authorization URL for a PKCE flow.
 *
 * The caller is responsible for generating the PKCE pair (see `generatePKCE`)
 * and persisting the verifier for the callback step.
 */
export function buildAnthropicAuthUrl(params: {
  challenge: string;
  verifier: string;
}): string {
  const qs = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_OAUTH.clientId,
    response_type: "code",
    redirect_uri: ANTHROPIC_OAUTH.redirectUri,
    scope: ANTHROPIC_OAUTH.scopes,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.verifier,
  });
  return `${ANTHROPIC_OAUTH.authorizeUrl}?${qs.toString()}`;
}

export interface AnthropicOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

/**
 * Exchange an Anthropic authorization code for OAuth tokens.
 *
 * Handles the `code#state` format that Anthropic returns.
 *
 * @param code     — The authorization code (may contain `#state` suffix)
 * @param state    — Explicit state param (used when not embedded in `code`)
 * @param verifier — The PKCE code verifier stored during the start step
 * @throws On network errors or non-2xx responses from Anthropic's token endpoint
 */
export async function exchangeAnthropicCode(params: {
  code: string;
  state?: string;
  verifier: string;
}): Promise<AnthropicOAuthTokens> {
  // Parse code#state format from Anthropic
  let actualCode = params.code;
  let state = params.state;
  if (params.code.includes("#")) {
    const parts = params.code.split("#");
    actualCode = parts[0];
    state = state ?? parts[1];
  }

  const resp = await fetch(ANTHROPIC_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH.clientId,
      code: actualCode,
      state,
      redirect_uri: ANTHROPIC_OAUTH.redirectUri,
      code_verifier: params.verifier,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic token exchange failed: ${err}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

// ── Unified refresh ──────────────────────────────────────────────────────

import type { OAuthCredentials } from "@mariozechner/pi-ai/dist/utils/oauth/types.js";
import { refreshAnthropicToken } from "@mariozechner/pi-ai/dist/utils/oauth/anthropic.js";
import { refreshGitHubCopilotToken } from "@mariozechner/pi-ai/dist/utils/oauth/github-copilot.js";
import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js";
import { refreshGoogleCloudToken } from "@mariozechner/pi-ai/dist/utils/oauth/google-gemini-cli.js";
import { refreshAntigravityToken } from "@mariozechner/pi-ai/dist/utils/oauth/google-antigravity.js";

/**
 * Refresh an OAuth token for any supported provider.
 *
 * @param oauthProviderId — The OAuth provider ID (e.g. "anthropic", "openai-codex")
 * @param credentials — The current credentials (must include a refresh token)
 * @returns Updated credentials with a fresh access token
 * @throws If the provider is unknown or refresh fails
 */
export async function refreshOAuthToken(
  oauthProviderId: string,
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  switch (oauthProviderId) {
    case "anthropic":
      return refreshAnthropicToken(credentials.refresh);
    case "github-copilot":
      return refreshGitHubCopilotToken(credentials.refresh);
    case "openai-codex":
      return refreshOpenAICodexToken(credentials.refresh);
    case "google-gemini-cli":
      return refreshGoogleCloudToken(credentials.refresh, (credentials as Record<string, unknown>).projectId as string ?? "");
    case "google-antigravity":
      return refreshAntigravityToken(credentials.refresh, (credentials as Record<string, unknown>).projectId as string ?? "");
    default:
      throw new Error(`Unknown OAuth provider: ${oauthProviderId}`);
  }
}
