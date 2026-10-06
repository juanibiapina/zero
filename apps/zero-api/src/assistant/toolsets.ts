import type { AgentToolSet } from "../agents/protocol";
import type { UserFileStore, StoredFile } from "../files/types";
import type { GoogleWorkspace } from "../google/types";
import type { ImageResizer } from "../images/types";
import type { MailWatchBook } from "../mail-watch/types";
import type { PageFetcher } from "../pagefetch/types";
import type { ScheduleBook } from "../schedules/types";
import type { TopicToolStore } from "../store/types";
import { buildCountryTool } from "../tools/country";
import { buildFileTools } from "../tools/files";
import { buildGoogleTools } from "../tools/google";
import { buildMailWatchTools } from "../tools/mail-watch";
import { buildReadPageTool } from "../tools/read-page";
import { buildScheduleTools } from "../tools/schedules";
import { buildTimezoneTool } from "../tools/timezone";
import { buildInterfaceTools, buildTopicTools } from "../tools/topics";
import {
  buildWebSearchTool,
  newWebSearchStats,
  type WebSearchStats,
} from "../tools/web-search";
import type { WebSearch } from "../websearch/types";

export interface InterfaceToolContext {
  topics: TopicToolStore;
  search: WebSearch;
  fetcher: PageFetcher;
  google: GoogleWorkspace;
  timezone: string;
  setTimezone?: (tz: string) => Promise<void>;
  setCountry?: (country: string) => Promise<void>;
  files?: UserFileStore;
  sendFile?: (file: StoredFile, bytes: Uint8Array) => Promise<void>;
  resizer?: ImageResizer;
  schedules?: ScheduleBook;
  mailWatch?: MailWatchBook;
  searchStats?: WebSearchStats;
}

export const interfaceToolset = (ctx: InterfaceToolContext): AgentToolSet => ({
  ...buildInterfaceTools({ store: ctx.topics, accessed: new Set() }),
  ...buildWebSearchTool({ search: ctx.search, stats: ctx.searchStats ?? newWebSearchStats() }),
  ...buildReadPageTool({ fetcher: ctx.fetcher }),
  ...buildTimezoneTool({ setTimezone: ctx.setTimezone }),
  ...buildCountryTool({ setCountry: ctx.setCountry }),
  ...buildGoogleTools({
    google: ctx.google,
    timezone: ctx.timezone,
    files: ctx.files,
    mailWatch: ctx.mailWatch,
  }),
  ...buildFileTools({
    files: ctx.files,
    sendFile: ctx.sendFile,
    resizer: ctx.resizer,
  }),
  ...buildScheduleTools({ schedules: ctx.schedules, timezone: ctx.timezone }),
  ...buildMailWatchTools({ mailWatch: ctx.mailWatch }),
});

export const learnerToolset = (topics: TopicToolStore): AgentToolSet =>
  buildTopicTools({ store: topics });

export const adminToolset = (topics: TopicToolStore): AgentToolSet =>
  buildTopicTools({ store: topics });

export const onboardingToolset = (
  topics: TopicToolStore,
  google: GoogleWorkspace,
): AgentToolSet => {
  const { gmail_search, gmail_thread } = buildGoogleTools({
    google,
    timezone: "UTC",
  });
  return { ...buildTopicTools({ store: topics }), gmail_search, gmail_thread };
};

const unreachable = (): never => {
  throw new Error("tool shape only");
};

const shapeTopics = new Proxy({} as TopicToolStore, { get: () => unreachable });
const shapeGoogle = new Proxy({} as GoogleWorkspace, { get: () => unreachable });

export const TOOL_SHAPES = {
  interface: interfaceToolset({
    topics: shapeTopics,
    search: { search: unreachable },
    fetcher: { fetch: unreachable },
    google: shapeGoogle,
    timezone: "UTC",
  }),
  learner: learnerToolset(shapeTopics),
  admin: adminToolset(shapeTopics),
  onboarding: onboardingToolset(shapeTopics, shapeGoogle),
};
