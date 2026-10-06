import { DurableObject } from "cloudflare:workers";
import type { Models } from "@earendil-works/pi-ai";
import { Harness, type AgentChange, type ConversationId } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import { InputFile } from "grammy";
import type { AgentToolSet } from "../agents/protocol";
import { recordAgentUsage } from "../agents/ai-usage";
import {
  createAssistant,
  CHECK_INTERVAL_MS,
  type Assistant,
  type AssistantJob,
  type OperationResult,
  type TelegramPort,
} from "../assistant/assistant";
import { BACKGROUND } from "../assistant/context";
import { buildZeroRegistry, summarizeWith, type AgentKind } from "../assistant/harness";
import { importLegacyConversations } from "../assistant/legacy-import";
import { createSqlLedger, type ChatRef, type Ledger } from "../assistant/ledger";
import { createGatewayModels, gatewayModelChoices, type ModelChoices } from "../assistant/models";
import {
  adminToolset,
  interfaceToolset,
  learnerToolset,
  onboardingToolset,
} from "../assistant/toolsets";
import { createRemoteUserData, type UserDataPort } from "../assistant/user-data";
import type { LearnReason } from "../do/learning-job";
import { createGoogleWorkspace } from "../google/rest";
import { getGoogleAccessToken, memoizeTokenProvider } from "../google-token";
import { createCloudflareImageResizer } from "../images/cloudflare";
import { fmtErr, log, logError } from "../log";
import { createTavilyFetcher } from "../pagefetch/tavily";
import { reportError } from "../reporting/zero-errors";
import { createBot } from "../telegram/bot";
import { sendChatAction } from "../telegram/chat-action";
import { sendMessage } from "../telegram/send-message";
import { TelegramFileSendError } from "../tools/files";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";
import { createBraveSearch } from "../websearch/brave";
import { selectBraveKey } from "../websearch/brave-key";
import { newWebSearchStats, type WebSearchStats } from "../tools/web-search";

const CHECK_JOB = "assistant-check";
const TOOLSET_TTL_MS = 60_000;

class Courier extends LifecycleCapability {
  constructor(private readonly assistant: () => Assistant) {
    super("zero-courier");
  }

  override onStart(): void {
    void this.assistant()
      .start()
      .catch((err: unknown) => logError("assistant_start_failed", { error: fmtErr(err) }));
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== "check") return;
    const pending = await this.assistant().check();
    return pending ? { rescheduleAt: Date.now() + CHECK_INTERVAL_MS } : undefined;
  }

  async schedule(at: number): Promise<void> {
    const existing = this.lifecycle.jobs.get(CHECK_JOB);
    if (existing && existing.time <= at) return;
    await this.lifecycle.jobs.push({ id: CHECK_JOB, fn: "check", time: at, singleflight: true });
  }
}

export class AssistantDO extends DurableObject<Env> {
  private readonly clerkUserId: string;
  private readonly ledger: Ledger;
  private readonly userData: UserDataPort;
  private agents: Record<AgentKind, AgentChange> | undefined;
  private readonly toolsets = new Map<string, { at: number; tools: AgentToolSet }>();
  private readonly searchStats = new Map<string, WebSearchStats>();
  private readonly harness: PiHarness;
  private readonly courier: Courier;
  private readonly assistant: Assistant;
  readonly lifecycle: Lifecycle<Env>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.clerkUserId = ctx.id.name ?? "unknown";
    this.ledger = createSqlLedger(ctx.storage.sql);
    this.userData = createRemoteUserData(getUserDO(env, this.clerkUserId));
    const { models, choices } = this.modelSetup(env, this.clerkUserId);
    const interfaceChoice = choices("interface");

    this.harness = new PiHarness({
      harness: ({ storage, context }) => {
        const { registry, settings, agents } = buildZeroRegistry({
          models,
          choices,
          toolsets: {
            interface: (id) => this.toolset("interface", id),
            learner: (id) => this.toolset("learner", id),
            onboarding: (id) => this.toolset("onboarding", id),
            admin: (id) => this.toolset("admin", id),
          },
          requestContext: () => this.userData.requestContext(),
          summarize: summarizeWith(models, choices),
          onCompaction: (conversationId) => {
            const chat = this.ledger.chatBySession(String(conversationId));
            void this.assistant.learn("size", chat?.conversationId);
          },
          recordUsage: ({ conversationId, agent, message }) => {
            const chat = this.ledger.chatBySession(String(conversationId));
            const usage = message.usage;
            recordAgentUsage(this.env, {
              clerkUserId: this.clerkUserId,
              model: message.model,
              agent,
              attribution: chat
                ? { conversationId: chat.conversationId, chatId: chat.chatId, topicId: chat.topicId }
                : undefined,
              usage: {
                inputTokens: usage.input,
                outputTokens: usage.output,
                cacheReadTokens: usage.cacheRead,
                cacheWriteTokens: usage.cacheWrite,
                cacheWrite5mTokens: usage.cacheWrite - (usage.cacheWrite1h ?? 0),
                cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
                costUsd: usage.cost.total,
                modelCalls: 1,
              },
              cost: {
                pricingVersion: message.model,
                pricingStatus: usage.cost.total > 0 ? "priced" : "unpriced",
                estimatedCostUsd: usage.cost.total,
              },
            });
          },
          contextWindow:
            models.getModel(interfaceChoice.model.provider, interfaceChoice.model.modelId)
              ?.contextWindow ?? 200_000,
        });
        this.agents = agents;
        return Harness.open(storage, { models, registry, settings }, context);
      },
      defaults: {
        model: { provider: interfaceChoice.model.provider, id: interfaceChoice.model.modelId },
        thinkingLevel: interfaceChoice.thinkingLevel,
      },
    });

    this.courier = new Courier(() => this.assistant);
    this.assistant = createAssistant({
      host: {
        pi: () => this.harness.pi(),
        agents: async () => {
          await this.harness.pi();
          if (!this.agents) throw new Error("assistant agents are not ready");
          return this.agents;
        },
        createSession: async (change) => {
          const session = await this.harness.sessions.create();
          const pi = await this.harness.pi();
          const conversation = await pi.conversation(Number(session.id) as ConversationId, BACKGROUND);
          await conversation!.configure(change, BACKGROUND);
          return session.id;
        },
        submit: async (session, text, operationId) => {
          await this.harness.submit(text, { session, operationId, whenBusy: "followUp" });
        },
        wait: async (session, operationId): Promise<OperationResult> => {
          const result = await this.harness.wait(operationId, { session });
          return { status: result.status, text: result.text, reason: result.reason };
        },
        reset: (session) => this.harness.session(session).reset(),
        scheduleCheck: (at) => this.courier.schedule(at),
      },
      ledger: this.ledger,
      telegram: this.telegramPort(env),
      reportError: (err, context, options) => reportError(this.env, err, context, options),
      clerkUserId: this.clerkUserId,
      turnFields: (session) => this.takeSearchStats(session),
    });
    this.lifecycle = Lifecycle.install(this).use(this.harness).use(this.courier);
  }

  protected modelSetup(env: Env, clerkUserId: string): { models: Models; choices: ModelChoices } {
    return {
      models: createGatewayModels(env, clerkUserId),
      choices: gatewayModelChoices(env, clerkUserId),
    };
  }

  protected telegramPort(env: Env): TelegramPort {
    return {
      send: (chat, text) => sendMessage(env, chat.chatId, chat.topicId, text),
      typing: (chat) => sendChatAction(env, chat.chatId, chat.topicId),
    };
  }

  private async toolset(kind: AgentKind, conversationId: ConversationId): Promise<AgentToolSet> {
    const key = `${kind}:${conversationId}`;
    const cached = this.toolsets.get(key);
    if (cached && Date.now() - cached.at < TOOLSET_TTL_MS) return cached.tools;
    const tools = await this.buildToolset(kind, String(conversationId));
    this.toolsets.set(key, { at: Date.now(), tools });
    return tools;
  }

  private statsFor(session: string): WebSearchStats {
    let stats = this.searchStats.get(session);
    if (!stats) {
      stats = newWebSearchStats();
      this.searchStats.set(session, stats);
    }
    return stats;
  }

  private takeSearchStats(session: string): Record<string, unknown> {
    const stats = this.searchStats.get(session);
    if (!stats) return {};
    const fields = {
      searches: stats.calls,
      searches_failed: stats.failed,
      searches_empty: stats.empty,
      unique_queries: stats.queries.size,
      search_ms_total: stats.durationMs,
    };
    stats.calls = 0;
    stats.failed = 0;
    stats.empty = 0;
    stats.durationMs = 0;
    stats.queries.clear();
    return fields;
  }

  private google() {
    return createGoogleWorkspace(
      memoizeTokenProvider(() => getGoogleAccessToken(this.env, this.clerkUserId)),
    );
  }

  private async buildToolset(kind: AgentKind, session: string): Promise<AgentToolSet> {
    const { topics } = this.userData;
    if (kind === "learner") return learnerToolset(topics);
    if (kind === "admin") return adminToolset(topics);
    if (kind === "onboarding") return onboardingToolset(topics, this.google());
    const chat = this.ledger.chatBySession(session);
    const settings = await this.userData.settings();
    const brave = selectBraveKey({
      paid: settings.braveKeyPaid,
      freeKey: this.env.BRAVE_API_KEY,
      paidKey: this.env.BRAVE_API_KEY_PAID,
    });
    return interfaceToolset({
      topics,
      search: createBraveSearch(brave.apiKey, { cohort: brave.cohort }),
      fetcher: createTavilyFetcher(this.env.TAVILY_API_KEY),
      google: this.google(),
      timezone: settings.timezone ?? "UTC",
      setTimezone: (tz) => this.userData.setTimezone(tz),
      setCountry: (country) => this.userData.setCountry(country),
      files: this.userData.files,
      sendFile: chat ? (file, bytes) => this.sendFile(chat, file, bytes) : undefined,
      resizer: createCloudflareImageResizer(this.env.IMAGES),
      schedules: chat ? this.userData.schedules(chat.conversationId) : undefined,
      mailWatch: chat ? this.userData.mailWatch(chat.conversationId) : undefined,
      searchStats: this.statsFor(session),
    });
  }

  private async sendFile(
    chat: ChatRef,
    file: { filename: string; mimeType: string },
    bytes: Uint8Array,
  ): Promise<void> {
    try {
      await createBot(this.env).api.sendDocument(chat.chatId, new InputFile(bytes, file.filename), {
        ...(chat.topicId && { message_thread_id: chat.topicId }),
      });
      log("file_sent", { byte_count: bytes.length, mime_major: file.mimeType.split("/")[0] });
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "error_code" in error
          ? Number(error.error_code)
          : 0;
      if (status) {
        throw new TelegramFileSendError(status, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  private importing: Promise<{ imported: number }> | undefined;

  private async ready(): Promise<void> {
    await this.lifecycle.start();
    this.importing ??= this.runImport().catch((err: unknown) => {
      this.importing = undefined;
      throw err;
    });
    await this.importing;
  }

  async submit(input: {
    chat: ChatRef;
    conversationId: string;
    text: string;
    operationId: string;
  }): Promise<void> {
    await this.ready();
    await this.assistant.submit(input);
  }

  async reset(chat: ChatRef): Promise<void> {
    await this.ready();
    await this.assistant.reset(chat);
  }

  async runJob(job: AssistantJob): Promise<OperationResult> {
    await this.ready();
    return this.assistant.runJob(job);
  }

  async learn(reason: LearnReason, conversationId?: string): Promise<void> {
    await this.ready();
    await this.assistant.learn(reason, conversationId);
  }

  async importLegacy(): Promise<void> {
    await this.ready();
  }

  private async runImport(): Promise<{ imported: number }> {
    return importLegacyConversations({
      source: getUserDO(this.env, this.clerkUserId),
      pi: await this.harness.pi(),
      ledger: this.ledger,
      agents: (await this.assistantAgents()).interface,
      createSession: async () => (await this.harness.sessions.create()).id,
      submit: (input) => this.assistant.submit(input),
    });
  }

  private async assistantAgents(): Promise<Record<AgentKind, AgentChange>> {
    await this.harness.pi();
    if (!this.agents) throw new Error("assistant agents are not ready");
    return this.agents;
  }

  async purge(): Promise<void> {
    await this.lifecycle.dispose();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  drop(): void {
    this.ctx.abort("assistant data deleted");
  }
}
