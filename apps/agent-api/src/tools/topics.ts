// Topic tools shared by both agents. `buildTopicTools` gives the read/write
// surface over the knowledge model (list/get/create/update/list_backlinks);
// `buildInterfaceTools` adds `reply` on top for the interface agent. Topics link
// to each other with Obsidian-style `[[Name]]` tokens in their bodies; the store
// keeps outbound/backlink rows in sync, and get_topic/list_backlinks expose them. Every topic read or write records
// the topic name in the optional `accessed` set so the interface agent can hand
// the writer exactly the topics it touched. `update_topic` is a partial patch:
// any field left out keeps its current value, so a body-only revision (the
// interface agent's usual call) leaves description/summary untouched, while the
// writer can also refresh those and rename in one call.
//
// `reply` persists the assistant message then sends it to the user immediately
// (live progress). Persist-before-send makes retries idempotent: the durable
// row commits behind the DO output gate before the Telegram fetch leaves, so a
// mid-run eviction leaves the tail already `assistant` and the retry skips the
// thread instead of re-sending.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { TopicStore } from "../store/types";

export interface TopicToolDeps {
  store: TopicStore;
  // Optional: the interface agent passes a set to record which topics it read or
  // wrote. The writer omits it — it has no downstream consumer of `accessed`.
  accessed?: Set<string>;
}

export const buildTopicTools = (deps: TopicToolDeps): ToolSet => {
  const { store, accessed } = deps;

  return {
    list_topics: tool({
      description:
        "List every topic with its metadata (name, description, summary) but no bodies. Use to see what topics exist.",
      inputSchema: z.object({}),
      execute: async () => store.listTopics(),
    }),

    get_topic: tool({
      description:
        "Get a topic's full content including its body, plus its links: " +
        "`outboundLinks` (topics its body links to via [[Name]]) and `backlinks` " +
        "(topics that link to it). Read it before revising it.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const topic = store.getTopic(name);
        if (!topic) return { error: `topic not found: ${name}` };
        accessed?.add(name);
        return {
          ...topic,
          outboundLinks: store.getOutboundLinks(name),
          backlinks: store.getBacklinks(name).map((t) => t.name),
        };
      },
    }),

    list_backlinks: tool({
      description:
        "List the topics whose body links to the named topic via [[Name]] " +
        "(its back-references). Use to find what references a topic before " +
        "renaming, merging, or answering \"what mentions X?\".",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        accessed?.add(name);
        return store.getBacklinks(name);
      },
    }),

    create_topic: tool({
      description:
        "Create a new topic for a subject worth remembering (a project, a person, an ongoing thread). Starts empty; fill it via update_topic.",
      inputSchema: z.object({ name: z.string(), description: z.string() }),
      execute: async ({ name, description }) => {
        if (store.getTopic(name)) return { error: `topic exists: ${name}` };
        store.createTopic(name, description);
        accessed?.add(name);
        return { created: name };
      },
    }),

    update_topic: tool({
      description:
        "Patch a topic. Provide only the fields to change: body (full markdown), " +
        "description (routing blurb), summary (state-of-the-topic), or newName to " +
        "rename. Omitted fields keep their current value.",
      inputSchema: z.object({
        name: z.string(),
        body: z.string().optional(),
        description: z.string().optional(),
        summary: z.string().optional(),
        newName: z.string().optional(),
      }),
      execute: async ({ name, body, description, summary, newName }) => {
        const current = store.getTopic(name);
        if (!current) return { error: `topic not found: ${name}` };
        try {
          store.saveTopic(
            name,
            {
              body: body ?? current.body,
              description: description ?? current.description,
              summary: summary ?? current.summary,
            },
            newName,
          );
          accessed?.add(name);
          if (newName) accessed?.add(newName);
          return { updated: newName ?? name };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
};

export interface InterfaceToolDeps {
  store: TopicStore;
  send: (text: string) => Promise<void>;
  // Persist the assistant message durably before it is sent. Called by `reply`
  // for every message the user sees.
  persistReply: (text: string) => void;
  accessed: Set<string>;
  replies: string[];
}

export const buildInterfaceTools = (deps: InterfaceToolDeps): ToolSet => {
  const { store, send, persistReply, accessed, replies } = deps;

  return {
    ...buildTopicTools({ store, accessed }),

    delete_topic: tool({
      description:
        "Permanently delete a topic. Irreversible: only call after the user has " +
        "explicitly confirmed. Other topics that link to it keep their [[Name]] " +
        "text as a dangling link.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        if (!store.getTopic(name)) return { error: `topic not found: ${name}` };
        try {
          store.deleteTopic(name);
          return { deleted: name };
        } catch (err) {
          // Rejected system-topic deletes surface as a tool error, not a throw.
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    reply: tool({
      description:
        "Send a message to the user, shown immediately. Call once per message you want the user to see; text not sent via reply is never shown.",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        // Persist before send (idempotency across DO eviction; see file header
        // and docs/topics.md). Push to `replies` only after the send resolves,
        // so a failed send is not counted as delivered — the interface agent's
        // no-silence fallback keys off replies.length.
        persistReply(text);
        await send(text);
        replies.push(text);
        return "sent";
      },
    }),
  };
};
