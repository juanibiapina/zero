import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { AssistantDO } from "../AssistantDO/index";
import type { TelegramPort } from "../assistant/assistant";
import type { Env } from "../types";

export { UserDO } from "../UserDO/index";
export { ScheduleDO } from "../ScheduleDO/index";

const faux = fauxProvider();

export const script = (steps: FauxResponseStep[]): void => faux.setResponses(steps);
export const modelCalls = (): number => faux.state.callCount;
export { fauxAssistantMessage };

export class TestAssistantDO extends AssistantDO {
  protected override modelSetup() {
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    return {
      models,
      choices: () => ({
        model: { provider: model.provider, modelId: model.id },
        thinkingLevel: "high" as const,
      }),
    };
  }

  protected override telegramPort(_env: Env): TelegramPort {
    return {
      send: async (chat, text) => {
        const sent = (await this.ctx.storage.get<string[]>("test:sent")) ?? [];
        sent.push(`${chat.chatId}:${chat.topicId}:${text}`);
        await this.ctx.storage.put("test:sent", sent);
      },
      typing: async () => {},
    };
  }

  async sentMessages(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("test:sent")) ?? [];
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("test worker");
  },
};
