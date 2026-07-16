# Zero Rewrite Plan

Rewrite juanibiapina/zero to replace Cloudflare Containers with an agentic system using Cloudflare Agents SDK. The new architecture uses "meta-agents" that receive full context in their prompt and process conversations statelessly.

## Goal

Replace the container-based pi-coding-agent with a simpler, domain-specific agent system:
- No general-purpose coding tools (read/write/bash)
- Specialized tools for managing a topic-based knowledge model
- Explicit reply tool instead of implicit stdout capture
- Two-phase processing: conversation agent → writer agent

## Current Architecture (to remove)

| Component | Role |
|-----------|------|
| `AgentContainer` | `Container` subclass per user running `@zero/agent-server` |
| `@zero/agent-server` | HTTP server wrapping pi-coding-agent |
| R2 `state.tar.gz` | Full `/workspace` archive per user (sessions, notes, attachments) |
| D1 `sessions` table | Session cost tracking |
| Secret proxy | Sentinel substitution for API keys in container egress |
| Callback routes | `/message-end`, `/agent-end`, `/state`, `/close-session` on `zero.worker` |

The container receives raw Telegram messages, runs pi-coding-agent with full tools, and posts replies back via HTTP callbacks. State persists as a tar archive on R2.

## New Architecture

### Core Concepts

**Meta-agent pattern**: The conversation agent is not a normal stateful agent. It receives a complete prompt containing:
- System instructions ("you are a processor for this conversation")
- Topic context (relevant topic bodies as long-term memory)
- Full conversation history
- The new user message

The agent processes this context and uses tools to interact with topics and reply to the user. After the agent completes, its internal state is discarded. Only the topic model and explicit conversation messages persist.

**Two-phase execution**:
1. **Conversation Agent**: Processes user message, has tools for topics and explicit `reply()`
2. **Writer Agent**: Consolidates knowledge into all topics that were accessed during phase 1

**Explicit replies**: Unlike pi (where all assistant text becomes the reply), the agent must call `reply(text)` for each message it wants to send. Only these become part of the conversation history.

**Tracked topics**: All topics read or written during the conversation agent's execution are tracked. These are all passed to the writer agent for potential updates.

### Topic Model

Ported from juanibiapina/agent. A **topic** is a durable subject with:
- Routing metadata (name, description, summary)
- A knowledge document (body) - living notes about the subject
- Activity tracking (timestamps, message count)

```typescript
interface Topic {
  name: string;           // human label, also the identifier
  description: string;    // routing blurb (what belongs here)
  summary: string;        // running state-of-the-topic
  body: string;           // knowledge document (markdown)
  createdAt: string;      // ISO 8601
  lastActiveAt: string;   // ISO 8601
  messageCount: number;
}
```

Topics serve as **long-term memory**. The conversation agent receives relevant topic bodies as context. The writer agent updates topic bodies with durable facts, decisions, and log entries after each exchange.

### SQLite Schema (in UserDO)

```sql
-- Topics: the knowledge model
CREATE TABLE topics (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

-- Conversations: map Telegram chats to conversation threads
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  topic_id INTEGER NOT NULL,  -- Telegram forum topic, 0 for DMs
  created_at TEXT NOT NULL,
  UNIQUE(chat_id, topic_id)
);

-- Messages: explicit user/assistant exchanges
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### Tools

**Conversation Agent Tools**:

| Tool | Description |
|------|-------------|
| `reply(text)` | Send a message to the user. Becomes part of conversation history. |
| `list_topics()` | List all topics with name, description, summary, dates, counts |
| `get_topic(name)` | Get full topic including body |
| `create_topic(name, description)` | Create a new topic |
| `update_topic(name, body)` | Update topic body (partial or full) |

All topic tools that read or write a topic add it to the "accessed topics" set.

**Writer Agent Tools**:

| Tool | Description |
|------|-------------|
| `save_topic(name, body, description, summary, newName?)` | Consolidate knowledge into a topic. Called once per accessed topic. |

The writer agent receives the list of accessed topics with their current bodies, the exchange (user message + all replies), and must call `save_topic` for each topic that needs updating.

## System Flow

```
Telegram webhook (POST /api/webhooks/telegram)
    │
    ├── Parse message, resolve user (KV tg:{telegramId} → clerkUserId)
    │
    ▼
UserDO.handleMessage(text, chatId, topicId, sendFn)
    │
    ├── 1. Get/create conversation from (chatId, topicId)
    │
    ├── 2. Store user message
    │
    ├── 3. Load conversation history (last N messages)
    │
    ├── 4. Build conversation agent prompt:
    │      ┌─────────────────────────────────────────────────────┐
    │      │ System: You are processing a conversation.         │
    │      │ Here is your long-term memory about relevant topics:│
    │      │ [Topic bodies or "no topics yet"]                  │
    │      │                                                     │
    │      │ Conversation history:                               │
    │      │ [user/assistant messages]                           │
    │      │                                                     │
    │      │ New message: {userMessage}                          │
    │      │                                                     │
    │      │ Use reply() to respond. Use topic tools to access   │
    │      │ and update your knowledge.                          │
    │      └─────────────────────────────────────────────────────┘
    │
    ├── 5. Run conversation agent (generateText with tools)
    │      ├── Tracks all topics accessed via topic tools
    │      ├── On reply(text) → send to Telegram, collect reply
    │      └── maxSteps: 10
    │
    ├── 6. Store assistant messages (all reply() calls)
    │
    ├── 7. Build writer agent prompt:
    │      ┌─────────────────────────────────────────────────────┐
    │      │ System: You maintain living knowledge documents.    │
    │      │                                                     │
    │      │ Accessed topics:                                    │
    │      │ - Topic A: [current body]                           │
    │      │ - Topic B: [current body]                           │
    │      │                                                     │
    │      │ Exchange:                                           │
    │      │ User: {userMessage}                                 │
    │      │ Assistant: {replies joined}                         │
    │      │                                                     │
    │      │ Call save_topic() for each topic that needs update. │
    │      └─────────────────────────────────────────────────────┘
    │
    ├── 8. Run writer agent (generateText with save_topic tool)
    │      └── Updates each topic's body, description, summary
    │
    └── 9. Agent state discarded. Only SQLite persists.
```

## Module Structure

```
apps/api/src/
├── index.ts                    # Worker entry, exports UserDO
├── app.ts                      # Hono app with routes
├── types.ts                    # Env type
├── log.ts                      # Logging helpers
│
├── routes/
│   ├── telegram-webhook.ts    # POST /api/webhooks/telegram
│   └── ... (keep existing auth routes)
│
├── UserDO/
│   ├── index.ts               # DurableObject class
│   ├── stub.ts                # Typed stub helper
│   └── db/
│       ├── schema.ts          # do-orm table definitions
│       └── migrations.ts      # Schema migrations
│
├── agents/
│   ├── conversation.ts        # Conversation agent (meta-agent)
│   ├── writer.ts              # Writer agent (knowledge consolidation)
│   └── prompts.ts             # System prompt builders
│
├── tools/
│   ├── reply.ts               # reply(text) tool
│   ├── topics.ts              # Topic CRUD tools
│   └── save-topic.ts          # Writer's save_topic tool
│
└── telegram/
    ├── send.ts                # formatAndSend helper
    └── chat-action.ts         # Typing indicator
```

## Implementation Details

### UserDO.handleMessage

```typescript
async handleMessage(
  text: string,
  chatId: number,
  topicId: number,
  send: (text: string) => Promise<void>
): Promise<void> {
  const conversationId = this.getOrCreateConversation(chatId, topicId);
  this.storeMessage(conversationId, 'user', text);
  
  const history = this.getConversationHistory(conversationId);
  const accessedTopics = new Set<string>();
  const replies: string[] = [];
  
  // Phase 1: Conversation agent
  await runConversationAgent({
    history,
    userMessage: text,
    tools: this.buildConversationTools(accessedTopics, replies, send),
    model: 'claude-sonnet-4-6',
  });
  
  // Store replies
  for (const reply of replies) {
    this.storeMessage(conversationId, 'assistant', reply);
  }
  
  // Phase 2: Writer agent (if any topics were accessed)
  if (accessedTopics.size > 0) {
    const topicsWithBodies = this.getTopicsWithBodies([...accessedTopics]);
    await runWriterAgent({
      topics: topicsWithBodies,
      exchange: { user: text, assistant: replies },
      saveTopic: (name, body, desc, summary, newName) => 
        this.updateTopic(name, { body, description: desc, summary }, newName),
      model: 'claude-sonnet-4-6',
    });
  }
}
```

### Conversation Agent

```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export async function runConversationAgent(opts: {
  history: Message[];
  userMessage: string;
  tools: Record<string, Tool>;
  model: string;
}) {
  const systemPrompt = buildConversationSystemPrompt();
  
  await generateText({
    model: anthropic(opts.model),
    system: systemPrompt,
    messages: [
      ...opts.history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: opts.userMessage },
    ],
    tools: opts.tools,
    maxSteps: 10,
  });
}

function buildConversationSystemPrompt(): string {
  return `You are processing a conversation. You have tools to:
- Reply to the user (use reply() for each message you want to send)
- Access and update your long-term memory via topics

Topics are your persistent knowledge about different subjects. Use them to remember facts, decisions, and context across conversations.

Always use reply() to respond. Your internal thinking is not shown to the user.`;
}
```

### Writer Agent

```typescript
export async function runWriterAgent(opts: {
  topics: Array<{ name: string; body: string; description: string; summary: string }>;
  exchange: { user: string; assistant: string[] };
  saveTopic: (name: string, body: string, desc: string, summary: string, newName?: string) => void;
  model: string;
}) {
  const exchangeText = `User: ${opts.exchange.user}\n\nAssistant: ${opts.exchange.assistant.join('\n\n')}`;
  
  const systemPrompt = `You maintain living knowledge documents. For each topic that was accessed:
1. Extract durable facts from the exchange
2. Integrate them into the topic body (add/merge, don't duplicate)
3. Append a one-line log entry for provenance
4. Refresh the description and summary

Call save_topic() for each topic that needs updating. Skip topics that don't need changes.`;
  
  const topicsContext = opts.topics.map(t => 
    `## ${t.name}\nDescription: ${t.description}\nSummary: ${t.summary}\n\n${t.body || '(empty)'}`
  ).join('\n\n---\n\n');
  
  await generateText({
    model: anthropic(opts.model),
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `# Accessed Topics\n\n${topicsContext}\n\n# Exchange\n\n${exchangeText}\n\nUpdate each topic as needed.`,
    }],
    tools: {
      save_topic: {
        description: 'Save updated topic content',
        parameters: z.object({
          name: z.string().describe('Current topic name'),
          body: z.string().describe('Updated topic body (markdown)'),
          description: z.string().describe('Routing description'),
          summary: z.string().describe('Running summary'),
          newName: z.string().optional().describe('New name if renaming'),
        }),
        execute: async (args) => {
          opts.saveTopic(args.name, args.body, args.description, args.summary, args.newName);
          return 'Topic saved';
        },
      },
    },
    maxSteps: opts.topics.length + 2, // One call per topic plus buffer
  });
}
```

### Topic Tools Factory

```typescript
function buildConversationTools(
  accessedTopics: Set<string>,
  replies: string[],
  send: (text: string) => Promise<void>,
  db: Database,
): Record<string, Tool> {
  return {
    reply: {
      description: 'Send a message to the user',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        replies.push(text);
        await send(text);
        return 'Message sent';
      },
    },
    
    list_topics: {
      description: 'List all topics with metadata',
      parameters: z.object({}),
      execute: async () => {
        const topics = db.all(topicsTable);
        return topics.map(t => ({
          name: t.name,
          description: t.description,
          summary: t.summary,
          lastActiveAt: t.lastActiveAt,
          messageCount: t.messageCount,
        }));
      },
    },
    
    get_topic: {
      description: 'Get full topic including body',
      parameters: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const topic = db.get(topicsTable, { where: eq('name', name) });
        if (!topic) return { error: 'Topic not found' };
        accessedTopics.add(name);
        return topic;
      },
    },
    
    create_topic: {
      description: 'Create a new topic',
      parameters: z.object({
        name: z.string(),
        description: z.string(),
      }),
      execute: async ({ name, description }) => {
        const now = new Date().toISOString();
        db.insert(topicsTable, {
          name,
          description,
          summary: '',
          body: '',
          createdAt: now,
          lastActiveAt: now,
          messageCount: 0,
        });
        accessedTopics.add(name);
        return { created: name };
      },
    },
    
    update_topic: {
      description: 'Update topic body',
      parameters: z.object({
        name: z.string(),
        body: z.string(),
      }),
      execute: async ({ name, body }) => {
        db.update(topicsTable, { body, lastActiveAt: new Date().toISOString() }, { where: eq('name', name) });
        accessedTopics.add(name);
        return { updated: name };
      },
    },
  };
}
```

## Migration Plan

### Phase 1: Schema and Infrastructure

1. Add new tables to `UserDO/db/schema.ts`: `topics`, `conversations`, `messages`
2. Add migration in `UserDO/db/migrations.ts`
3. Implement topic CRUD methods in `UserDO/index.ts`
4. Implement conversation/message storage methods
5. Add `@ai-sdk/anthropic` and `ai` dependencies

### Phase 2: Agent System

1. Create `agents/prompts.ts` with system prompt builders
2. Create `tools/reply.ts` with reply tool factory
3. Create `tools/topics.ts` with topic tools factory
4. Create `agents/conversation.ts` with conversation agent
5. Create `tools/save-topic.ts` with save_topic tool
6. Create `agents/writer.ts` with writer agent
7. Implement `UserDO.handleMessage` orchestrating both agents

### Phase 3: Telegram Integration

1. Update `routes/telegram-webhook.ts` to call `UserDO.handleMessage`
2. Remove session-based routing (no more agent-client)
3. Keep typing indicator (markSessionActive/Idle pattern)
4. Keep attachment handling (store in DO blob storage or skip for MVP)

### Phase 4: Cleanup

1. Remove `AgentContainer.ts`
2. Remove `agent-client.ts`
3. Remove `process-topic-message.ts`
4. Remove `handle-agent-end.ts`
5. Remove `secret-proxy.ts` and `ai-gateway.ts`
6. Remove `packages/agent-server/` entirely
7. Update `wrangler.jsonc`: remove containers config, update migrations
8. Remove R2 bucket binding (or keep for future attachment support)
9. Remove D1 sessions database (or repurpose for cost tracking if needed)

## Key Differences from Current System

| Aspect | Current (Containers) | New (Agents) |
|--------|---------------------|-------------|
| Runtime | Container per user with Node.js | Worker + DurableObject |
| State | tar.gz on R2 | SQLite in DO |
| Agent | pi-coding-agent (full tools) | Meta-agents (domain tools) |
| Tools | read, write, bash, edit | topics, reply |
| Output | Implicit (all assistant text) | Explicit (`reply()` calls) |
| Knowledge | Session files + notes | Topic model in SQLite |
| Secrets | Sentinel substitution | Direct env access (no container) |

## Key Differences from juanibiapina/agent

| Aspect | juanibiapina/agent | Zero (new) |
|--------|-------------------|------------|
| Runtime | Local Node.js | Cloudflare Workers + DO |
| Topic routing | Interface agent routes to topic agents | Conversation agent accesses topics directly |
| Per-topic agents | Yes (pi session per topic) | No (single conversation agent) |
| Storage | Filesystem (markdown files) | SQLite in DurableObject |
| Topic persistence | Topic files in vault | Topics table in DO |

## Test Strategy

1. **Unit tests for tools**: Each tool function tested in isolation
2. **Unit tests for UserDO methods**: Topic/conversation CRUD
3. **Integration tests for agents**: Mock LLM responses, verify tool calls
4. **E2E tests**: Telegram webhook → UserDO → mock Anthropic → Telegram reply

## Skills to Use

- **code** - for implementation
- **tdd** - for test-driven development of tools and agents
- **git-commit** - for atomic commits
- **cloudflare** - reference for DO patterns and Agents SDK

## Acceptance Criteria

1. User sends message via Telegram → receives reply via `reply()` tool
2. Conversation history persists across messages
3. Topics created/accessed during conversation are updated by writer agent
4. Agent state is discarded after each message (only SQLite persists)
5. Existing auth flow (Clerk, Telegram login) continues working
6. Typing indicator shows while agent is processing
7. All container-related code removed
8. CI passes (build, lint, tests)

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| DO storage limits (10GB) | Topics are text; unlikely to hit. Monitor. |
| Agent token limits | Keep conversation history bounded (last N messages) |
| Tool execution time | Workers have 30s CPU limit; agents should complete in time |
| Migration data loss | No user data in topics yet; clean migration |
| Anthropic rate limits | Use AI Gateway for caching and rate limiting |

## Dependencies to Add

```json
{
  "ai": "^4.x",
  "@ai-sdk/anthropic": "^1.x"
}
```

## Dependencies to Remove

- `@cloudflare/containers`
- `@zero/agent-server` (entire package)
- `@earendil-works/pi-coding-agent` (from agent-server)
- `@earendil-works/pi-ai` (from agent-server)
