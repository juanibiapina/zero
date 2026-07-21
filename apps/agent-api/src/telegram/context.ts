// A resolved Telegram message target: who sent it and which chat/topic thread
// it belongs to. DMs use topicId=0 so the rest of the pipeline is uniform.
export interface TopicContext {
  telegramId: string;
  chatId: number;
  topicId: number;
}
