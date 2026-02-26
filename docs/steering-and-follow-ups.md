# Steering & Follow-up Messages

## Overview

When the agent is running, users can send two kinds of messages:

- **Steering**: Injected mid-run at the next turn boundary. The agent sees it during the current run.
- **Follow-up**: Queued while the agent is running. Sent as a new `sendMessage()` after the current run finishes, starting a fresh agent loop.

When the agent is idle, Enter sends a normal message (starts a new agent loop).

## Input Behavior

| Agent status | Enter | ⌥Enter (Option+Enter) |
|---|---|---|
| Idle | Send message (starts agent loop) | Same as Enter |
| Running | Steer (inject mid-run) | Follow-up (queue for after) |

Placeholder text when running: `"Enter to steer · ⌥Enter for follow-up"`

## UI Requirements

### Message labels

User messages are tagged with their kind:

| Kind | Icon | Color | Label |
|---|---|---|---|
| Normal message | MessageSquare | Blue | _(none)_ |
| Steering | Navigation | Orange | "Steering" |
| Follow-up | Clock | Purple | "Follow-up" |

### Message positioning

Steering and follow-up messages stay **pinned at the bottom of the chat, above the input bar**, until the agent actually processes them. They should not scroll up into the conversation history until they are consumed.

- A **steering** message moves into the conversation flow once the agent picks it up at the next turn boundary (i.e. the agent responds to it).
- A **follow-up** message moves into the conversation flow once the current run finishes and the follow-up is sent as a new message (i.e. the agent starts processing it).
- While pinned, the messages should be visually distinct from messages already in the conversation (e.g. reduced opacity, different background, or a separator).

### Stop behavior

- Pressing Stop clears any pending follow-up.
- Pressing Stop clears any pending steer messages.
- Pinned messages should be removed from the UI when cleared.

### Buttons

- Send button is always visible.
- Stop button appears alongside the Send button when the agent is running.

## Protocol

`SessionClientMessage` types:

- `{ type: "message", text }` — Normal message when idle, steer when running.
- `{ type: "follow_up", text }` — Follow-up (queued until agent finishes).
- `{ type: "stop" }` — Stop the agent.
- `{ type: "steer", text }` — Explicit steer (not currently used by frontend; `message` auto-routes).

## Backend Behavior

### Agent-server (`SessionWrapper`)

- `steer(text)` pushes to `_steerQueue`. The agent loop drains via `getQueuedMessages` at each turn boundary.
- `stop()` clears `_steerQueue`.
- Post-`agent_end`: if `_steerQueue` still has messages, starts a new loop with the next one instead of going idle.

### SessionDO

- `handleUserMessage`: Routes based on status — `container.steer()` if running, `container.sendMessage()` if idle.
- `handleFollowUp`: Persists/broadcasts immediately. If running, stores in `pendingFollowUp`. If idle, sends immediately.
- `handleContainerEvent`: When status transitions to idle, drains `pendingFollowUp` by calling `container.sendMessage()`.
- `handleStop`: Clears `pendingFollowUp`.
