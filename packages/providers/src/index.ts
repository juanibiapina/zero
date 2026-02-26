/**
 * @zero/providers — AI provider registry, model catalog, and OAuth helpers.
 *
 * A thin layer over @mariozechner/pi-ai's submodules, safe for use in
 * Cloudflare Workers and browser environments (no heavy vendor SDKs).
 */

export {
  getProviderRegistry,
  getProviderMeta,
  getDefaultModel,
  type ProviderMeta,
} from "./registry.js";

export {
  getProviders,
  getModels,
  getModel,
  calculateCost,
  modelsAreEqual,
  type KnownProvider,
  type Provider,
  type Api,
  type KnownApi,
  type Model,
} from "./models.js";

export {
  // Types
  type OAuthCredentials,
  type OAuthProviderInterface,
  type OAuthProviderId,
  type OAuthLoginCallbacks,
  type OAuthAuthInfo,
  type OAuthPrompt,
  // PKCE
  generatePKCE,
  // Anthropic
  loginAnthropic,
  refreshAnthropicToken,
  anthropicOAuthProvider,
  // GitHub Copilot
  loginGitHubCopilot,
  refreshGitHubCopilotToken,
  githubCopilotOAuthProvider,
  // OpenAI Codex
  loginOpenAICodex,
  refreshOpenAICodexToken,
  openaiCodexOAuthProvider,
  // Google Gemini CLI
  loginGeminiCli,
  refreshGoogleCloudToken,
  geminiCliOAuthProvider,
  // Google Antigravity
  loginAntigravity,
  refreshAntigravityToken,
  antigravityOAuthProvider,
  // Unified
  refreshOAuthToken,
} from "./oauth.js";
