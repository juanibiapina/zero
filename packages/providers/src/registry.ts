/**
 * Provider registry — metadata for all known AI providers.
 *
 * Combines pi-ai's dynamic provider list with static metadata
 * (display names, auth capabilities, env var names).
 */

import type { KnownProvider } from "@mariozechner/pi-ai/dist/types.js";
import { getModels } from "@mariozechner/pi-ai/dist/models.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface ProviderMeta {
  /** Provider identifier (matches pi-ai KnownProvider) */
  id: KnownProvider;
  /** Human-readable display name */
  name: string;
  /** Whether the provider accepts a user-supplied API key */
  supportsApiKey: boolean;
  /** Whether the provider supports OAuth authentication */
  supportsOAuth: boolean;
  /** Environment variable name for the API key (null if not applicable) */
  envVar: string | null;
  /** OAuth provider ID in pi-ai's OAuth registry (null if no OAuth) */
  oauthProviderId: string | null;
}

// ── Static metadata ──────────────────────────────────────────────────────

/**
 * Static metadata for each provider.
 *
 * Auth capabilities and env var names are sourced from pi-ai's
 * env-api-keys.js and oauth modules.
 */
const PROVIDER_META: Record<KnownProvider, Omit<ProviderMeta, "id">> = {
  anthropic: {
    name: "Anthropic",
    supportsApiKey: true,
    supportsOAuth: true,
    envVar: "ANTHROPIC_API_KEY",
    oauthProviderId: "anthropic",
  },
  openai: {
    name: "OpenAI",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "OPENAI_API_KEY",
    oauthProviderId: null,
  },
  "openai-codex": {
    name: "ChatGPT Plus/Pro (Codex)",
    supportsApiKey: false,
    supportsOAuth: false, // TODO: implement web OAuth flow (needs localhost callback rewrite)
    envVar: null,
    oauthProviderId: "openai-codex",
  },
  google: {
    name: "Google Gemini",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "GEMINI_API_KEY",
    oauthProviderId: null,
  },
  "google-gemini-cli": {
    name: "Google Gemini CLI",
    supportsApiKey: false,
    supportsOAuth: false, // TODO: implement web OAuth flow (needs localhost callback rewrite)
    envVar: null,
    oauthProviderId: "google-gemini-cli",
  },
  "google-antigravity": {
    name: "Google Antigravity",
    supportsApiKey: false,
    supportsOAuth: false, // TODO: implement web OAuth flow (needs localhost callback rewrite)
    envVar: null,
    oauthProviderId: "google-antigravity",
  },
  "google-vertex": {
    name: "Google Vertex AI",
    supportsApiKey: false,
    supportsOAuth: false,
    envVar: null,
    oauthProviderId: null,
  },
  "amazon-bedrock": {
    name: "Amazon Bedrock",
    supportsApiKey: false,
    supportsOAuth: false,
    envVar: null,
    oauthProviderId: null,
  },
  "azure-openai-responses": {
    name: "Azure OpenAI",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "AZURE_OPENAI_API_KEY",
    oauthProviderId: null,
  },
  "github-copilot": {
    name: "GitHub Copilot",
    supportsApiKey: false,
    supportsOAuth: false, // TODO: implement web OAuth flow (device code polling)
    envVar: null,
    oauthProviderId: "github-copilot",
  },
  xai: {
    name: "xAI",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "XAI_API_KEY",
    oauthProviderId: null,
  },
  groq: {
    name: "Groq",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "GROQ_API_KEY",
    oauthProviderId: null,
  },
  cerebras: {
    name: "Cerebras",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "CEREBRAS_API_KEY",
    oauthProviderId: null,
  },
  openrouter: {
    name: "OpenRouter",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "OPENROUTER_API_KEY",
    oauthProviderId: null,
  },
  "vercel-ai-gateway": {
    name: "Vercel AI Gateway",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "AI_GATEWAY_API_KEY",
    oauthProviderId: null,
  },
  zai: {
    name: "ZAI",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "ZAI_API_KEY",
    oauthProviderId: null,
  },
  mistral: {
    name: "Mistral",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "MISTRAL_API_KEY",
    oauthProviderId: null,
  },
  minimax: {
    name: "MiniMax",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "MINIMAX_API_KEY",
    oauthProviderId: null,
  },
  "minimax-cn": {
    name: "MiniMax CN",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "MINIMAX_CN_API_KEY",
    oauthProviderId: null,
  },
  huggingface: {
    name: "Hugging Face",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "HF_TOKEN",
    oauthProviderId: null,
  },
  opencode: {
    name: "OpenCode",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "OPENCODE_API_KEY",
    oauthProviderId: null,
  },
  "kimi-coding": {
    name: "Kimi Coding",
    supportsApiKey: true,
    supportsOAuth: false,
    envVar: "KIMI_API_KEY",
    oauthProviderId: null,
  },
};

// ── Public API ───────────────────────────────────────────────────────────

/** Get metadata for all known providers. */
export function getProviderRegistry(): ProviderMeta[] {
  return (Object.entries(PROVIDER_META) as [KnownProvider, Omit<ProviderMeta, "id">][]).map(
    ([id, meta]) => ({ id, ...meta }),
  );
}

/** Get metadata for a specific provider. */
export function getProviderMeta(id: string): ProviderMeta | undefined {
  const meta = PROVIDER_META[id as KnownProvider];
  if (!meta) return undefined;
  return { id: id as KnownProvider, ...meta };
}

/**
 * Get a sensible default model ID for a provider.
 * Returns the first model in pi-ai's catalog for that provider,
 * or undefined if the provider has no models.
 */
export function getDefaultModel(provider: string): string | undefined {
  const models = getModels(provider as KnownProvider);
  if (models.length === 0) return undefined;

  // Prefer well-known defaults for common providers
  const preferredDefaults: Partial<Record<string, string>> = {
    anthropic: "claude-sonnet-4-20250514",
    openai: "gpt-4.1",
    google: "gemini-2.5-flash",
    xai: "grok-3-mini",
    groq: "llama-4-scout-17b-16e-instruct",
    mistral: "mistral-large-latest",
  };

  const preferred = preferredDefaults[provider];
  if (preferred && models.some((m) => m.id === preferred)) {
    return preferred;
  }

  return models[0].id;
}
