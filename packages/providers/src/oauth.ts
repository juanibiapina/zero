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
