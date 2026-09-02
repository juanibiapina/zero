import { table, column, ref } from "do-orm";

export const telegramLink = table("telegram_link", {
  id: column.integer().primaryKey().autoIncrement(),
  telegramId: column.text().notNull().unique(),
});

export const userSettings = table("user_settings", {
  id: column.integer().primaryKey().autoIncrement(),
  onboardingSeen: column.integer().notNull(),
  googleOnboardingStatus: column.text(),
  createdAt: column.text(),
  // Canonical IANA name (e.g. "Europe/Berlin"), never an offset. Null until the
  // web app reports the browser's zone on first mount.
  timezone: column.text(),
  // Uppercase ISO 3166-1 alpha-2 code, or null when no usable signal exists.
  country: column.text(),
  // When Zero first introduced itself. Set exactly once, by claimFirstContact.
  firstContactAt: column.text(),
  // Gmail's mailbox history watermark: where the next poll for replies on
  // watched threads starts. One per user, not per thread (see mail_threads).
  mailHistoryId: column.text(),
  // Last time the user sent anything. The mail poll stops re-arming once this
  // is a week old, so idle accounts cost nothing.
  lastActiveAt: column.text(),
  // When Zero last woke this sleeper. Null until the first wake; compared with
  // lastActiveAt to send one message per sleep episode (see docs/wake-sleepers.md).
  wokeAt: column.text(),
  // Canary flag: 1 routes this user's web searches to the paid Brave key (see
  // docs/plans/brave-paid-canary.md). 0/off by default.
  braveKeyPaid: column.integer().notNull().default(0),
});

// Topics: the durable knowledge model. `id` is a stable surrogate key so a
// rename is a one-field `name` update; `name` is what the agent addresses.
export const topics = table("topics", {
  id: column.integer().notNull().primaryKey().autoIncrement(),
  name: column.text().notNull().unique(),
  description: column.text().notNull().default(""),
  body: column.text().notNull().default(""),
  createdAt: column.text().notNull(),
  lastActiveAt: column.text().notNull(),
  messageCount: column.integer().notNull().default(0),
  // Pinned topics are always rendered into the interface agent's prompt (see
  // docs/topics.md). Ordinary topics otherwise; pinning is set via the Store.
  pinned: column.integer().notNull().default(0),
});

// The user's knowledge version: one counter covering every topic body, the
// catalog and the link graph. Single row (id = 1). `systemFingerprint` is the
// fingerprint of the bundled system topics whose content the counter last
// accounted for.
export const knowledge = table("knowledge", {
  id: column.integer().notNull().primaryKey(),
  version: column.integer().notNull().default(1),
  systemFingerprint: column.text(),
});

// Topic links: the `[[Name]]` wiki-links found in a topic body, one row per
// (source topic, target name). `targetId` resolves to the target topic when one
// with that exact `name` exists, else null (a dangling link). Rows are
// re-derived from the body on every write, so they never drift from the text.
export const topicLinks = table("topic_links", {
  sourceId: column.integer().notNull().references(ref(topics, "id")),
  targetName: column.text().notNull(),
  targetId: column.integer().references(ref(topics, "id")),
});

// Conversations: one thread per Telegram (chatId, topicId).
// `compactedThroughMessageId` and `summary` are the compaction boundary: the
// model sees the summary plus the messages after the boundary, while the raw
// rows stay in place for learning. Both NULL means nothing has been compacted.
export const conversations = table("conversations", {
  id: column.text().notNull().primaryKey(),
  chatId: column.integer().notNull(),
  topicId: column.integer().notNull(),
  createdAt: column.text().notNull(),
  compactedThroughMessageId: column.integer(),
  summary: column.text(),
  // Newest message that predates delivery claims; rows at or below it were sent
  // by the pre-claim code and must not be redelivered. See migration 0029.
  deliveredThroughMessageId: column.integer(),
});

// Messages: the conversation's append-only protocol log. `content` is a JSON
// array of wire-format content blocks (text, tool_use, tool_result, image), so
// a turn's tool calls and results survive into later turns. `kind` names the
// row (user_message / assistant_message / tool_result), `stopReason` is the
// model's own reason for ending an assistant response (null for user rows),
// and `consolidatedAt` is set once learning has folded the row into topics.
export const messages = table("messages", {
  id: column.integer().notNull().primaryKey().autoIncrement(),
  conversationId: column.text().notNull(),
  role: column.text().notNull(),
  content: column.text().notNull(),
  kind: column.text().notNull().default("user_message"),
  stopReason: column.text(),
  // The model's own id for this response, chained into the next request's cache
  // diagnostics so a cross-turn cache break is visible.
  responseId: column.text(),
  consolidatedAt: column.text(),
  createdAt: column.text().notNull(),
});

// Pending messages: Telegram inputs waiting to enter the transcript. The
// webhook enqueues here; a turn injects them at a safe point in arrival order.
// `injectedAt` marks a row already drained into `messages`.
export const pendingMessages = table("pending_messages", {
  id: column.integer().notNull().primaryKey().autoIncrement(),
  conversationId: column.text().notNull(),
  content: column.text().notNull(),
  createdAt: column.text().notNull(),
  injectedAt: column.text(),
});

// Deliveries: one row per assistant text block handed to Telegram, claimed
// before the send leaves. A resumed run skips claimed blocks, which is what
// keeps delivery at-most-once without putting delivery state in the transcript.
export const deliveries = table("deliveries", {
  messageId: column.integer().notNull().references(ref(messages, "id")),
  blockIndex: column.integer().notNull(),
  claimedAt: column.text().notNull(),
});

// User-owned file metadata. Bytes live in R2 under storageKey; legacy rows keep
// their attachments/ key and null size until the file store backfills it.
export const files = table("files", {
  id: column.text().notNull().primaryKey(),
  storageKey: column.text().notNull(),
  filename: column.text().notNull(),
  mimeType: column.text().notNull(),
  byteSize: column.integer(),
  createdAt: column.text().notNull(),
});

// External calls: one row per irreversible outbound action (send mail, create a
// calendar event), keyed by the model's tool_use id. Claimed 'started' before
// the request leaves and 'completed' with the serialized result after it
// returns, so a resumed turn can tell "already done" from "outcome unknown"
// instead of firing it twice.
export const externalCalls = table("external_calls", {
  toolUseId: column.text().notNull().primaryKey(),
  tool: column.text().notNull(),
  status: column.text().notNull(),
  result: column.text(),
  startedAt: column.text().notNull(),
  completedAt: column.text(),
});

// Learning jobs: the frozen input range of one consolidation run. A job covers
// messages up to `highWaterMessageId` and nothing that arrived after it started,
// and its completion (stamping those messages consolidated) is idempotent.
export const learningJobs = table("learning_jobs", {
  jobId: column.text().notNull().primaryKey(),
  highWaterMessageId: column.integer().notNull(),
  startedAt: column.text().notNull(),
  completedAt: column.text(),
});

// Schedules: one row per thing the user asked Zero to do later. `prompt` is an
// instruction to Zero's future self; when the row comes due the prompt is
// enqueued as a pending message and the ordinary turn path answers it.
// `pattern` is a five-field cron expression or an ISO-8601 local datetime,
// read in `timezone` (snapshotted at creation, never re-read from settings).
// `nextDueAt` is epoch ms and NULL once the row is retired.
export const schedules = table("schedules", {
  id: column.text().notNull().primaryKey(),
  conversationId: column.text().notNull().references(ref(conversations, "id")),
  prompt: column.text().notNull(),
  pattern: column.text().notNull(),
  timezone: column.text().notNull(),
  nextDueAt: column.integer(),
  status: column.text().notNull().default("active"),
  createdAt: column.text().notNull(),
  lastFiredAt: column.text(),
});

// Gmail threads Zero watches for replies, each bound to the conversation the
// notification lands in. No historyId here: the watermark is per mailbox and
// lives on user_settings (see migration 0034).
export const mailThreads = table("mail_threads", {
  threadId: column.text().notNull().primaryKey(),
  conversationId: column.text().notNull().references(ref(conversations, "id")),
  status: column.text().notNull().default("active"),
  createdAt: column.text().notNull(),
  lastNotifiedAt: column.text(),
});

// Webhook idempotency: dedupe fully re-delivered Telegram updates.
export const processedUpdates = table("processed_updates", {
  updateId: column.text().notNull().primaryKey(),
  createdAt: column.text().notNull(),
});

// The GTD Captures list (the Todoist replacement). Standalone from the agent's
// tables; owned by DbCaptureStore. Captures are the rows where processedAt IS
// NULL; createdAt is the Captures order.
export const captures = table("captures", {
  // The client mints the id (a UUID) and re-sends it verbatim on every
  // retry/replay, so the primary key itself dedupes a lost-ACK double-insert.
  id: column.text().notNull().primaryKey(),
  text: column.text().notNull(),
  createdAt: column.text().notNull(),
  processedAt: column.text(),
  // Local day (YYYY-MM-DD) the capture should reappear on. NULL = always
  // visible. Postpone sets it; the visibility filter runs server-side.
  showUpDate: column.text(),
  // Fractional-index sort key (base-62 string) for the manual list order.
  // Nullable: NULL means "unkeyed", which sorts LAST. In practice every stored
  // row is keyed — `add` mints a trailing key, `reorder` sets one, and an init
  // backfill (DbCaptureStore.backfillSortKeys) keys legacy rows so they keep
  // their place instead of sinking below newly-keyed adds — so NULL is only a
  // transient legacy state (pre-backfill) or the client's optimistic just-added
  // row. Not NOT NULL because ADD COLUMN (migration 0045) can't carry it on a
  // populated table and a valid key can't be minted in SQL.
  sortKey: column.text(),
});

// The Today list (the Todoist replacement). A Task is a typed, clarified
// next-action with a day, distinct from a Capture. Owned by DbTaskStore. Open
// tasks are the rows where completedAt IS NULL; showUpDate is the local day the
// task is due (client-side "due today" filter). See docs/entities/task.md.
export const tasks = table("tasks", {
  // The client mints the id (a UUID) and re-sends it verbatim on every
  // retry/replay, so the primary key itself dedupes a lost-ACK double-insert.
  id: column.text().notNull().primaryKey(),
  text: column.text().notNull(),
  // Local date (YYYY-MM-DD) the task should show up on.
  showUpDate: column.text().notNull(),
  createdAt: column.text().notNull(),
  completedAt: column.text(),
});
