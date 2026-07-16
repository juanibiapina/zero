// Interface-agent tools. Every topic read or write records the topic name in
// `accessed` so the writer agent can later consolidate exactly those topics.
// `reply` sends to the user immediately (live progress) and collects the text
// for persistence.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { TopicStore } from "../store/types";

export interface InterfaceToolDeps {
  store: TopicStore;
  send: (text: string) => Promise<void>;
  accessed: Set<string>;
  replies: string[];
}

export const buildInterfaceTools = (deps: InterfaceToolDeps): ToolSet => {
  const { store, send, accessed, replies } = deps;

  return {
    reply: tool({
      description:
        "Send a message to the user now. Call once per message you want shown.",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        replies.push(text);
        await send(text);
        return "sent";
      },
    }),

    list_topics: tool({
      description: "List all topics with their metadata (no bodies).",
      inputSchema: z.object({}),
      execute: async () => store.listTopics(),
    }),

    get_topic: tool({
      description: "Get a topic's full content including its body.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const topic = store.getTopic(name);
        if (!topic) return { error: `topic not found: ${name}` };
        accessed.add(name);
        return topic;
      },
    }),

    create_topic: tool({
      description: "Create a new topic for a subject worth remembering.",
      inputSchema: z.object({ name: z.string(), description: z.string() }),
      execute: async ({ name, description }) => {
        if (store.getTopic(name)) return { error: `topic exists: ${name}` };
        store.createTopic(name, description);
        accessed.add(name);
        return { created: name };
      },
    }),

    update_topic: tool({
      description: "Replace a topic's body with revised content.",
      inputSchema: z.object({ name: z.string(), body: z.string() }),
      execute: async ({ name, body }) => {
        if (!store.getTopic(name)) return { error: `topic not found: ${name}` };
        store.updateTopicBody(name, body);
        accessed.add(name);
        return { updated: name };
      },
    }),
  };
};
