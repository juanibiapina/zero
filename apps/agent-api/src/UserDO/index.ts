import { DurableObject } from "cloudflare:workers";
import { createDb, type Database } from "do-orm";
import { migrate } from "do-orm";
import { migrations } from "./db/migrations";
import { sendChatAction } from "../telegram/chat-action";
import { sendMessage } from "../telegram/send-message";
import { DbStore } from "../store/db";
import { SystemTopicStore } from "../store/system-topics";
import type { Store } from "../store/types";
import { createR2Attachments } from "../attachments/r2";
import type { AttachmentStore } from "../attachments/types";
import { createModel, createModelFactory } from "../agents/model";
import { createBraveSearch } from "../websearch/brave";
import { createTavilyFetcher } from "../pagefetch/tavily";
import { createGoogleWorkspace } from "../google/rest";
import { getGoogleAccessToken, memoizeTokenProvider } from "../google-token";
import { runTurn as orchestrateTurn } from "../agents/orchestrator";
import { runOnboardingAgent } from "../agents/onboarding";
import { runAlarmTurns } from "../do/alarm";
import { reportError } from "../reporting/zero-errors";
import { runOnboarding } from "../do/onboarding";
import type { Env } from "../types";

// How often the typing loop re-sends the Telegram "typing" action. Telegram's action expires after ~5s.
const TYPING_INTERVAL_MS = 4000;

// The stable pinned topic seeded by Google onboarding. The name never changes;
// the user's actual name is a fact recorded in the body (see docs/onboarding.md).
const USER_TOPIC = "User";
const USER_TOPIC_DESCRIPTION =
  "Durable facts about the user: name, location, role, languages, key relationships.";


export class UserDO extends DurableObject<Env> {
  private db: Database;
  // Wrapped in SystemTopicStore so the read-only system topics (Zero,
  // Changelog) are overlaid on every read and blocked from writes. See
  // store/system-topics.ts.
  private store: Store;
  // Attachment bytes (R2). Metadata rows live in `store`; bytes live here.
  private attachments: AttachmentStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);
    this.store = new SystemTopicStore(new DbStore(this.db));
    this.attachments = createR2Attachments(env.ATTACHMENTS);

    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
    });
  }

  // --- Conversations and messages ---

  resetConversation(chatId: number, topicId: number): void {
    this.store.resetConversation(chatId, topicId);
  }

  // --- Turn execution (DO alarm) ---

  // Cheap, synchronous-ish enqueue: dedupe the webhook update, store the user
  // message, and arm the alarm. No LLM work here (the webhook waitUntil caps at
  // ~30s); the turn runs in alarm() with a much larger budget.
  async enqueueTurn(input: {
    updateId: string;
    clerkUserId: string;
    chatId: number;
    topicId: number;
    text: string;
    // Attachment metadata rows to persist for this turn. Bytes are already in
    // R2 (the webhook put them); the message text carries their markers.
    attachments?: Array<{
      id: string;
      r2Key: string;
      filename: string;
      mimeType: string;
    }>;
  }): Promise<void> {
    if (!this.store.markProcessed(input.updateId)) return;
    await this.ctx.storage.put("clerkUserId", input.clerkUserId);
    const conversationId = this.store.getOrCreateConversation(
      input.chatId,
      input.topicId,
    );
    for (const a of input.attachments ?? []) {
      this.store.putAttachment({ ...a, conversationId });
    }
    this.store.storeMessage(conversationId, "user", input.text);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  // The turn runner. Drains every thread whose tail is a user message. A
  // concurrent enqueueTurn arms a fresh alarm (this handler cleared the old
  // one on entry), so messages that arrive mid-run are picked up on the next
  // fire. On a catchable failure runAlarmTurns self-reschedules with backoff
  // while any thread still awaits reply, and returns normally (never rethrows,
  // which would discard the reschedule). See do/alarm.ts.
  //
  // After turns are drained (replies stay low-latency), run Google onboarding
  // if it is queued. Onboarding is best-effort and off Telegram, so it waits
  // behind turn draining.
  override async alarm(): Promise<void> {
    await runAlarmTurns({
      storage: this.ctx.storage,
      findThreadsAwaitingReply: () => this.store.findThreadsAwaitingReply(),
      runTurn: (chatId, topicId) => this.runTurn(chatId, topicId),
      reportError: (err) => reportError(this.env, err, { site: "alarm_turn" }),
    });
    if (this.store.getSettings().googleOnboardingStatus === "queued") {
      await this.runOnboarding();
    }
  }

  // Queue Google onboarding: set status `queued` and arm the alarm. Idempotent
  // by default — once the status leaves `null` (queued/done/failed) this
  // no-ops, so the web app's fire-once effect onboards a user at most once.
  // `force` bypasses the guard to re-run for an already-onboarded user
  // (re-running is idempotent: it re-authors the same pinned topic). Called by
  // POST /api/onboarding/google.
  async queueOnboarding(force = false): Promise<void> {
    if (!force && this.store.getSettings().googleOnboardingStatus !== null)
      return;
    this.store.setGoogleOnboardingStatus("queued");
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  // Run the one-shot Gmail onboarding scan. Builds the per-user model and
  // memoized Google token, then delegates the topic-seeding + status state
  // machine to do/onboarding.ts (kept there so it is testable without a DO).
  private async runOnboarding(): Promise<void> {
    const clerkUserId =
      (await this.ctx.storage.get<string>("clerkUserId")) ?? "unknown";
    const model = await createModel(this.env, clerkUserId, "onboarding");
    const getToken = memoizeTokenProvider(() =>
      getGoogleAccessToken(this.env, clerkUserId),
    );
    const google = createGoogleWorkspace(getToken);

    await runOnboarding({
      store: this.store,
      topicName: USER_TOPIC,
      description: USER_TOPIC_DESCRIPTION,
      runAgent: (topicName) =>
        runOnboardingAgent({ model, store: this.store, google, topicName }),
      setStatus: (status) => this.store.setGoogleOnboardingStatus(status),
    });
  }

  // Run one thread end to end inside the DO: local typing loop, model creation
  // (per-user gateway tagging), then the runtime-agnostic orchestrator. The
  // typing loop is a self-rescheduling setTimeout, not the DO alarm timer, so
  // the alarm stays dedicated to turn scheduling.
  private async runTurn(chatId: number, topicId: number): Promise<void> {
    const clerkUserId =
      (await this.ctx.storage.get<string>("clerkUserId")) ?? "unknown";
    const makeModel = await createModelFactory(this.env, clerkUserId);
    const search = createBraveSearch(this.env.BRAVE_API_KEY);
    const fetcher = createTavilyFetcher(this.env.TAVILY_API_KEY);
    // Memoized Google token provider: the first Google tool call mints a token
    // via Clerk and caches the promise for the turn; turns that never touch
    // Google make zero Clerk calls. A ~1h token outlives any turn.
    const getToken = memoizeTokenProvider(() =>
      getGoogleAccessToken(this.env, clerkUserId),
    );
    const google = createGoogleWorkspace(getToken);
    const timezone = this.store.getSettings().timezone ?? undefined;
    const setTimezone = (tz: string) =>
      this.store.updateSettings({ timezone: tz });
    const send = (text: string) => sendMessage(this.env, chatId, topicId, text);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void sendChatAction(this.env, chatId, topicId).catch(() => {});
      timer = setTimeout(tick, TYPING_INTERVAL_MS);
    };
    tick();
    try {
      await orchestrateTurn({ store: this.store, makeModel, send, search, fetcher, google, attachments: this.attachments, chatId, topicId, clerkUserId, timezone, setTimezone });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // --- Telegram link / settings RPC (delegate to the Store) ---
  // These stay public: routes/user-settings.ts and routes/admin.ts call them.

  getTelegramId(): string | null {
    return this.store.getTelegramId();
  }

  linkTelegram(telegramId: string): { previous: string | null } {
    return this.store.linkTelegram(telegramId);
  }

  async unlinkTelegram(): Promise<{ removed: string | null }> {
    const { removed } = this.store.unlinkTelegram();
    if (!removed) return { removed: null };
    // Purge the user's stored images: unlinking is an account teardown path, so
    // their photos leave with their data. clerkUserId is set on first enqueue,
    // which is also the only path that creates attachments, so a null here means
    // nothing to purge.
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    if (clerkUserId) await this.attachments.deleteAllForUser(clerkUserId);
    return { removed };
  }

  getSettings(): {
    onboardingSeen: boolean;
    googleOnboardingStatus: string | null;
    createdAt: string | null;
    timezone: string | null;
    isNewUser: boolean;
  } {
    return this.store.getSettings();
  }

  updateSettings(patch: { onboardingSeen?: boolean; timezone?: string }): void {
    this.store.updateSettings(patch);
  }

  setGoogleOnboardingStatus(status: string): void {
    this.store.setGoogleOnboardingStatus(status);
  }
}
