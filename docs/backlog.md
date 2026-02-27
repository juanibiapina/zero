# Zero — Feature Backlog

Unimplemented feature ideas.

---

### Git Push Credentials + PR Creation Tool

The container has `gh` CLI installed and git credentials are configured via `credential.helper` using the user's `GITHUB_TOKEN` secret. The agent can push branches and create PRs via `gh pr create`. What's missing is a dedicated `create_pull_request` tool registered in the agent's tool set so the agent can create PRs programmatically without relying on the CLI being available or the user having set a `GITHUB_TOKEN` secret. The tool would use the GitHub App installation token (already available in the container) instead of requiring a personal token.

---

### Steering + Follow-up Messages

When the agent is running, users should be able to steer mid-run (inject at next turn boundary) or queue follow-up messages. Currently `steer()` throws in the agent-server.

The UI should support distinct input modes (steer on Enter, follow-up on ⌥Enter while agent is running), pinned pending messages above the input bar that move into the conversation once processed, and visual labels/colors per message kind (normal, steering, follow-up) — matching pi TUI patterns.

Full design spec: [`docs/steering-and-follow-ups.md`](steering-and-follow-ups.md)

---

### Container Sharing Strategy (Per-Project)

Currently one container per session. Per-project containers (`containerName = 'project-{projectDOId}'`) would share a warm container across sessions for the same repo — second session starts fast, workspace is already cloned. Tradeoff: only one active session per project at a time.

---

### Session Auto-Titles via Workers AI

Sessions are titled `"Session {first-8-chars}"`. On first user message, fire a Workers AI call (`@cf/meta/llama-3.1-8b-instruct`) in background via `ctx.waitUntil()` to generate a 3–6 word title. Fast, cheap (free tier), no Anthropic credits. Requires `AI: Ai` binding in wrangler.

---

### Agent-Suggested Actions

New `suggest_actions` tool registered alongside coding tools. The agent calls it at the end of a task to propose follow-up actions as structured buttons. Frontend renders them as clickable chips; clicking sends the action text as a user message. Actions are persisted in `session_events` and replayed on reconnect.

---

### File Browser + Diff Viewer

Two possible modes:
- **GitHub API tree** (always available, no container needed): browse files at any commit
- **Live container filesystem** (only when session active): shows working directory including uncommitted changes

Diff viewer: `git diff HEAD` in the container, rendered as a "Changes" tab in SessionPage. No design committed yet.

---

### Inbox + Notifications (Phase 3)

Unified notification store (InboxDO) for GitHub webhooks, emails, messages. Global feed + per-project views. Async LLM enrichment for suggested actions on notifications. Not yet started — depends on the core session experience stabilizing first.

---

### OAuth for Remaining Providers

Four providers have OAuth login/refresh helpers already re-exported in `@zero/providers/oauth.ts` but are marked `supportsOAuth: false` in the registry: `openai-codex`, `github-copilot`, `google-gemini-cli`, and `google-antigravity`. The pi-ai login functions assume a terminal or localhost redirect, which doesn't work for a web app. Each needs a web-compatible two-step start/complete flow (like the existing Anthropic PKCE flow in `buildAnthropicAuthUrl` / `exchangeAnthropicCode`). `github-copilot` uses device code polling, which needs its own UI (show code → poll for completion).

---

### Switch Session Model & Thinking Level

Currently model and provider are fixed at session creation (inherited from project defaults, stored in `session_meta`). Users should be able to change them mid-session and see the current model per session. This also applies to thinking level — pi-ai models support a `thinkingLevel` parameter but Zero doesn't expose it anywhere. Needs: a session header UI showing current model/thinking level, controls to switch, an API endpoint to update `session_meta`, and an agent-server endpoint (or extension to `/message`) to reconfigure the model on the fly.

---

### Prompt Templates & Slash Commands

User-managed prompt templates stored in UserDO. Templates are always injected into sessions as system prompt context (the agent-server currently hardcodes a minimal system prompt). Users can also invoke specific templates via `/slash` commands typed in the chat input — e.g. `/review` to inject a code review prompt. Needs: CRUD API and UI for managing templates, a flag per template for "always active" vs "slash-only", template resolution in SessionDO before forwarding to the container, and input parsing in the frontend to detect `/` prefixes and show autocomplete.

---

### Per-Project Todo Lists

User-managed todo items per project, stored in UserDO (new table) or a dedicated DO. Viewable and editable in the project detail page UI. Key feature: todos can be easily sent to a session as context (e.g. "here are the outstanding tasks") or automatically picked up by the coding agent. Could also support marking items as done from within a session.

---

### Show More Tool Info in UI by Default

`ToolCallBlockView` currently shows just the tool name as a collapsed button — you have to click to see arguments. On desktop there's enough horizontal space to show key arguments inline on the same line (e.g. file path for read/write, command for bash). This avoids unnecessary clicks for the most common tools and makes scanning a session much faster.

---

### Key Prefix Timeout in Settings

The hotkey sequence timeout (time allowed between pressing the prefix key and the action key) is currently fixed at ~1 second. Add a user-configurable timeout to `UserSettings` (in `@zero/core`) and expose it in the settings UI. The value would be passed to `useHotkeySequence` from `@tanstack/react-hotkeys`.
