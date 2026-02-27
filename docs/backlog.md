# Zero — Feature Backlog

Unimplemented feature ideas, ordered roughly by priority.

---

### Git Push Credentials + PR Creation Tool

The container has `gh` CLI installed and git credentials are configured via `credential.helper` using the user's `GITHUB_TOKEN` secret. The agent can push branches and create PRs via `gh pr create`. What's missing is a dedicated `create_pull_request` tool registered in the agent's tool set so the agent can create PRs programmatically without relying on the CLI being available or the user having set a `GITHUB_TOKEN` secret. The tool would use the GitHub App installation token (already available in the container) instead of requiring a personal token.

---

### Steering + Follow-up Messages

When the agent is running, users should be able to steer mid-run (inject at next turn boundary) or queue follow-up messages. Currently `steer()` throws in the agent-server.

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
