// Topic tools shared by both agents. `buildTopicTools` gives the read/write
// surface over the knowledge model (list/get/create/update/edit/append/list_backlinks);
// `buildInterfaceTools` adds `reply` on top for the interface agent. Topics link
// to each other with Obsidian-style `[[Name]]` tokens in their bodies; the store
// keeps outbound/backlink rows in sync, and get_topic/list_backlinks expose them. Every topic read or write records
// the topic name in the optional `accessed` set so the interface agent can hand
// the writer exactly the topics it touched. `update_topic` is a partial patch:
// any field left out keeps its current value, so a body-only revision (the
// interface agent's usual call) leaves description/summary untouched, while the
// writer can also refresh those and rename in one call.
//
// `edit_topic` and `append_topic` are the incremental body writes, and the
// default path for revising an existing document. `update_topic`'s `body` is the
// WHOLE markdown document, so preserving a body while adding one line to it
// costs the model the entire document in generated tokens — a cost that grows
// with the topic forever (measured: 13,856 output tokens and 298s on a single
// turn; see docs/plans/writer-latency-investigation.md). Anchored edits make the
// cost proportional to the change, not to the document. `update_topic` stays for
// description/summary/rename and for filling a freshly created empty topic.
//
// Both incremental tools check `getTopic` themselves rather than relying on the
// store to reject an unknown name: `DbStore.updateTopicBody` silently no-ops on
// a missing topic while `MemoryStore.updateTopicBody` throws, so leaning on the
// store would pass tests and lose writes in production.
//
// `reply` persists the assistant message then sends it to the user immediately
// (live progress). Persist-before-send makes retries idempotent: the durable
// row commits behind the DO output gate before the Telegram fetch leaves, so a
// mid-run eviction leaves the tail already `assistant` and the retry skips the
// thread instead of re-sending.

import { defineTool, type AgentToolSet } from "../agents/protocol";
import { z } from "zod";
import type { TopicStore } from "../store/types";

export interface TopicToolDeps {
  store: TopicStore;
  // Optional: the interface agent passes a set to record which topics it read or
  // wrote. The writer omits it — it has no downstream consumer of `accessed`.
  accessed?: Set<string>;
}

export const buildTopicTools = (deps: TopicToolDeps): AgentToolSet => {
  const { store, accessed } = deps;

  return {
    list_topics: defineTool({
      description:
        "List every topic with its metadata (name, description, summary) but no bodies. Use to see what topics exist.",
      inputSchema: z.object({}),
      execute: async () => store.listTopics(),
    }),

    get_topic: defineTool({
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

    list_backlinks: defineTool({
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

    create_topic: defineTool({
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

    update_topic: defineTool({
      description:
        "Patch a topic. Provide only the fields to change: body (full markdown), " +
        "description (routing blurb), summary (state-of-the-topic), or newName to " +
        "rename. Omitted fields keep their current value. `body` replaces the " +
        "whole document, so use it only to fill a topic that is still empty; to " +
        "revise an existing body use edit_topic or append_topic.",
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

    edit_topic: defineTool({
      description:
        "Revise part of a topic's body by replacing an exact snippet of it. " +
        "`oldText` must appear exactly once in the current body; everything else " +
        "is left byte-for-byte untouched. Use this instead of update_topic to " +
        "change an existing document: quote only the lines you are changing " +
        "(a heading plus the lines under it is a good anchor), never the whole " +
        "body. Read the body with get_topic first so the anchor matches exactly.",
      inputSchema: z.object({
        name: z.string(),
        oldText: z.string(),
        newText: z.string(),
      }),
      execute: async ({ name, oldText, newText }) => {
        const current = store.getTopic(name);
        if (!current) return { error: `topic not found: ${name}` };
        if (oldText === "")
          return {
            error:
              "oldText must not be empty: use append_topic to add to the end of a body",
          };
        const first = current.body.indexOf(oldText);
        if (first === -1)
          return {
            error: `oldText not found in ${name}: it must match the body exactly, including whitespace. Call get_topic to read the current body.`,
          };
        if (current.body.indexOf(oldText, first + 1) !== -1)
          return {
            error: `oldText appears more than once in ${name}: extend it with surrounding lines until it is unique.`,
          };
        try {
          store.updateTopicBody(
            name,
            current.body.slice(0, first) +
              newText +
              current.body.slice(first + oldText.length),
          );
          accessed?.add(name);
          return { updated: name };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    append_topic: defineTool({
      description:
        "Append text to the end of a topic's body, separated by a blank line. " +
        "Use for a new section or a log line; nothing already in the body is " +
        "regenerated. To change text that is already there, use edit_topic.",
      inputSchema: z.object({ name: z.string(), text: z.string() }),
      execute: async ({ name, text }) => {
        const current = store.getTopic(name);
        if (!current) return { error: `topic not found: ${name}` };
        const existing = current.body.replace(/\s+$/, "");
        const addition = text.replace(/^\s+|\s+$/g, "");
        try {
          store.updateTopicBody(
            name,
            existing === "" ? addition : `${existing}\n\n${addition}`,
          );
          accessed?.add(name);
          return { updated: name };
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

export const buildInterfaceTools = (deps: InterfaceToolDeps): AgentToolSet => {
  const { store, send, persistReply, accessed, replies } = deps;

  return {
    ...buildTopicTools({ store, accessed }),

    delete_topic: defineTool({
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

    reply: defineTool({
      description:
        "Send a message to the user, shown immediately. Call once per message you want the user to see.",
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
