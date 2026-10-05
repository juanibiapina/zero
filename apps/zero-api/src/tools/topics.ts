// Topic tools shared by both agents. `buildTopicTools` gives the read/write
// surface over the knowledge model (list/get/create/edit/append/metadata/
// list_backlinks); `buildInterfaceTools` adds `delete_topic` on top for the
// interface agent. Topics link to each other with Obsidian-style
// `[[Name]]` tokens in their bodies; the store keeps outbound/backlink rows in
// sync, and get_topic/list_backlinks expose them. Every topic read or write
// records the topic name in the optional `accessed` set so the interface agent
// can hand the writer exactly the topics it touched.
//
// A topic holds exactly two model-written fields: `description`, a short
// routing blurb rendered by list_topics, and `body`, the one authoritative
// knowledge document. There is deliberately no second summary of the same
// state to keep in sync.
//
// Every read returns the user's `version`; every write states the
// `expectedVersion` it was based on. A write on a stale version changes nothing
// and returns a recoverable error telling the model to reread. That is what
// makes a persisted tool result safe to keep in a conversation: knowledge it
// captured can be detected as out of date, and two conversations writing at
// once cannot clobber each other. A successful write returns the new version,
// so a chain of edits can use each result as the next expectedVersion.
//
// No tool replaces a complete non-empty body. `create_topic` writes a topic
// whole, `edit_topic` replaces an exact anchor inside a body, `append_topic`
// adds to the end, and `update_topic_metadata` never accepts body text.
// Re-emitting a whole document costs the model the entire body in generated
// tokens on every small change, a cost that grows with the topic forever
// (measured: 13,856 output tokens and 298s on one turn; see
// docs/plans/writer-latency-investigation.md).
//
// The write tools check `getTopic` themselves rather than relying on the store
// to reject an unknown name, so a missing topic is a normal tool error rather
// than a thrown adapter difference.

import { defineTool, type AgentToolSet } from "../agents/protocol";
import { z } from "zod";
import { log } from "../log";
import { KnowledgeConflictError, type TopicToolStore } from "../store/types";

export interface TopicToolDeps {
  // Sync in a turn (the DO's own SQLite), async when learning reaches another
  // Durable Object over RPC. One tool module, two transports.
  store: TopicToolStore;
  // Optional: the interface agent passes a set to record which topics it read or
  // wrote. The writer omits it — it has no downstream consumer of `accessed`.
  accessed?: Set<string>;
  // Optional get_topic counter. Dropping `summary` from list_topics is only a
  // saving if the model does not answer it with extra full-body reads, so the
  // caller logs this count per run next to topic_list_rendered.
  reads?: { count: number };
}

// Run a topic write, turning both a stale-version conflict and an ordinary
// store rejection (unknown name, name collision, read-only system topic) into a
// tool error the model can act on. A conflict is logged so the cost of the
// single global counter is measurable in production; the topic name and any
// content stay out of the log.
const write = async <T>(
  tool: string,
  apply: () => Promise<T>,
): Promise<T | { error: string }> => {
  try {
    return await apply();
  } catch (err) {
    if (err instanceof KnowledgeConflictError) {
      log("topic_write_conflict", {
        tool,
        expected_version: err.expected,
        current_version: err.current,
      });
      return { error: err.message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

export const buildTopicTools = (deps: TopicToolDeps): AgentToolSet => {
  const { store, accessed, reads } = deps;

  return {
    list_topics: defineTool({
      description:
        "List every topic by name with a short routing description. Bodies are " +
        "not included; read one with get_topic.",
      inputSchema: z.object({}),
      execute: async () => {
        const listed = (await store.listTopics()).map((t) => ({
          name: t.name,
          description: t.description,
        }));
        log("topic_list_rendered", {
          topic_count: listed.length,
          chars: JSON.stringify(listed).length,
        });
        return { version: await store.getKnowledgeVersion(), topics: listed };
      },
    }),

    get_topic: defineTool({
      description:
        "Get a topic's full content including its body, plus its links: " +
        "`outboundLinks` (topics its body links to via [[Name]]) and `backlinks` " +
        "(topics that link to it). Read it before revising it.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const topic = await store.getTopic(name);
        if (!topic) return { error: `topic not found: ${name}` };
        accessed?.add(name);
        if (reads) reads.count += 1;
        return {
          version: await store.getKnowledgeVersion(),
          topic: {
            ...topic,
            outboundLinks: await store.getOutboundLinks(name),
            backlinks: (await store.getBacklinks(name)).map((t) => t.name),
          },
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
        return {
          version: await store.getKnowledgeVersion(),
          topics: await store.getBacklinks(name),
        };
      },
    }),

    create_topic: defineTool({
      description:
        "Create a new topic for a subject worth remembering (a project, a " +
        "person, an ongoing thread), complete with its body. `expectedVersion` " +
        "is the version from your latest topic read. Fails if the name is taken.",
      inputSchema: z.object({
        expectedVersion: z.number(),
        name: z.string(),
        description: z.string(),
        body: z.string(),
      }),
      execute: async ({ expectedVersion, name, description, body }) => {
        if (body.trim() === "")
          return {
            error:
              "body must not be empty: create a topic with its content, not as an empty shell",
          };
        if (await store.getTopic(name)) return { error: `topic exists: ${name}` };
        return write("create_topic", async () => {
          const version = await store.createTopic({
            expectedVersion,
            name,
            description,
            body,
          });
          accessed?.add(name);
          return { created: name, version };
        });
      },
    }),

    edit_topic: defineTool({
      description:
        "Revise part of a topic's body by replacing an exact snippet of it. " +
        "`oldText` must appear exactly once in the current body; everything else " +
        "is left byte-for-byte untouched. Quote only the lines you are changing " +
        "(a heading plus the lines under it is a good anchor), never the whole " +
        "body. Read the body with get_topic first so the anchor matches exactly " +
        "and you have the current `expectedVersion`.",
      inputSchema: z.object({
        expectedVersion: z.number(),
        name: z.string(),
        oldText: z.string(),
        newText: z.string(),
      }),
      execute: async ({ expectedVersion, name, oldText, newText }) => {
        const current = await store.getTopic(name);
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
        return write("edit_topic", async () => {
          const version = await store.updateTopicBody({
            expectedVersion,
            name,
            body:
              current.body.slice(0, first) +
              newText +
              current.body.slice(first + oldText.length),
          });
          accessed?.add(name);
          return { updated: name, version };
        });
      },
    }),

    append_topic: defineTool({
      description:
        "Append text to the end of a topic's body, separated by a blank line. " +
        "Use for a new section or a log line, or to fill a topic whose body is " +
        "still empty; nothing already in the body is regenerated. To change text " +
        "that is already there, use edit_topic.",
      inputSchema: z.object({
        expectedVersion: z.number(),
        name: z.string(),
        text: z.string(),
      }),
      execute: async ({ expectedVersion, name, text }) => {
        const current = await store.getTopic(name);
        if (!current) return { error: `topic not found: ${name}` };
        const addition = text.replace(/^\s+|\s+$/g, "");
        if (addition === "") return { error: "text must not be empty" };
        const existing = current.body.replace(/\s+$/, "");
        return write("append_topic", async () => {
          const version = await store.updateTopicBody({
            expectedVersion,
            name,
            body: existing === "" ? addition : `${existing}\n\n${addition}`,
          });
          accessed?.add(name);
          return { updated: name, version };
        });
      },
    }),

    update_topic_metadata: defineTool({
      description:
        "Change a topic's routing description and/or its name. Never touches " +
        "the body: use edit_topic or append_topic for content. Provide at least " +
        "one of `description` or `newName`.",
      inputSchema: z.object({
        expectedVersion: z.number(),
        name: z.string(),
        description: z.string().optional(),
        newName: z.string().optional(),
      }),
      execute: async ({ expectedVersion, name, description, newName }) => {
        const current = await store.getTopic(name);
        if (!current) return { error: `topic not found: ${name}` };
        const renaming = newName !== undefined && newName !== name;
        const redescribing =
          description !== undefined && description !== current.description;
        if (!renaming && !redescribing)
          return {
            error:
              "nothing to change: provide a new description or a different newName",
          };
        return write("update_topic_metadata", async () => {
          const version = await store.updateTopicMetadata({
            expectedVersion,
            name,
            ...(redescribing ? { description } : {}),
            ...(renaming ? { newName } : {}),
          });
          accessed?.add(name);
          if (renaming && newName) accessed?.add(newName);
          return { updated: renaming && newName ? newName : name, version };
        });
      },
    }),
  };
};

export interface InterfaceToolDeps {
  store: TopicToolStore;
  accessed: Set<string>;
  reads?: { count: number };
}

// The interface agent's toolset: the shared topic tools plus delete_topic.
// There is no `reply` tool — the assistant's own text blocks are the messages
// the user sees, delivered by the runner as they are produced (see
// agents/run.ts `onText` and agents/interface.ts).
export const buildInterfaceTools = (deps: InterfaceToolDeps): AgentToolSet => {
  const { store, accessed, reads } = deps;

  return {
    ...buildTopicTools({ store, accessed, reads }),

    delete_topic: defineTool({
      description:
        "Permanently delete a topic. Irreversible: only call after the user has " +
        "explicitly confirmed. Other topics that link to it keep their [[Name]] " +
        "text as a dangling link.",
      inputSchema: z.object({
        expectedVersion: z.number(),
        name: z.string(),
      }),
      execute: async ({ expectedVersion, name }) => {
        if (!(await store.getTopic(name)))
          return { error: `topic not found: ${name}` };
        // Rejected system-topic deletes surface as a tool error, not a throw.
        return write("delete_topic", async () => ({
          deleted: name,
          version: await store.deleteTopic({ expectedVersion, name }),
        }));
      },
    }),
  };
};
