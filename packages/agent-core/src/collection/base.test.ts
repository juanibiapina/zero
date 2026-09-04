import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createLiveQueryCollection, eq } from "@tanstack/db";

import {
  createInMemoryEntityApi,
  reconcileWrites,
  verbsFor,
  type EntitySpec,
} from "./base";

// A synthetic entity with the three verb shapes the real entities use: an
// insert, an update that leaves the working set (like Project → done), and two
// field updates told apart by their changed field set (like Capture edit vs
// reschedule).
type Note = {
  id: string;
  text: string;
  tag: string | null;
  done: boolean;
  createdAt: string;
};

const note = (id: string, over: Partial<Note> = {}): Note => ({
  id,
  text: id,
  tag: null,
  done: false,
  createdAt: "2020-01-01T00:00:00.000Z",
  ...over,
});

// A fake server with a small latency so the optimistic overlay and the
// reconciling refetch resolve on separate ticks (where a flicker would show).
function fakeServer(initial: Note[]) {
  const rows = initial.map((n) => ({ ...n }));
  const calls = { add: 0, finish: 0, edit: 0, tag: 0 };
  const find = (id: string) => {
    const row = rows.find((n) => n.id === id);
    if (!row) throw new Error(`no note ${id}`);
    return row;
  };
  return {
    calls,
    fetch: async () => {
      await sleep(5);
      return rows.filter((n) => !n.done).map((n) => ({ ...n }));
    },
    add: async (n: Note) => {
      await sleep(5);
      calls.add++;
      const existing = rows.find((r) => r.id === n.id);
      if (existing) return { ...existing };
      rows.push({ ...n });
      return { ...n };
    },
    finish: async (id: string) => {
      await sleep(5);
      calls.finish++;
      const row = find(id);
      row.done = true;
      return { ...row };
    },
    edit: async (id: string, text: string) => {
      await sleep(5);
      calls.edit++;
      const row = find(id);
      row.text = text;
      return { ...row };
    },
    tag: async (id: string, tag: string | null) => {
      await sleep(5);
      calls.tag++;
      const row = find(id);
      row.tag = tag;
      return { ...row };
    },
  };
}

function notesSpec(server: ReturnType<typeof fakeServer>) {
  const v = verbsFor<Note>();
  const verbs = {
    addNote: v.insert<{ text: string }>({
      row: ({ text }) => ({ text, tag: null, done: false }),
      persist: (row) => server.add(row),
    }),
    finishNote: v.update<{ id: string }>({
      id: ({ id }) => id,
      draft: () => (d) => {
        d.done = true;
      },
      matches: ({ modified }) => modified.done,
      persist: (id) => server.finish(id),
    }),
    tagNote: v.update<{ id: string; tag: string | null }>({
      id: ({ id }) => id,
      draft:
        ({ tag }) =>
        (d) => {
          d.tag = tag;
        },
      matches: ({ changes }) => "tag" in changes,
      persist: (id, { modified }) => server.tag(id, modified.tag),
    }),
    // Catch-all, last.
    editNote: v.update<{ id: string; text: string }>({
      id: ({ id }) => id,
      draft:
        ({ text }) =>
        (d) => {
          d.text = text;
        },
      matches: () => true,
      persist: (id, { modified }) => server.edit(id, modified.text),
    }),
  };
  const spec: EntitySpec<Note, typeof verbs> = {
    name: "notes",
    fetch: server.fetch,
    leavesCollection: (n) => n.done,
    verbs,
  };
  return spec;
}

// Presence of an item across snapshots must be a single contiguous block of
// `true`, never doubled: once it appears it stays until an operation removes it,
// once removed it never returns, and it is never shown twice at once.
function expectNoFlicker(snapshots: string[][], id: string): void {
  for (const snapshot of snapshots) {
    expect(snapshot.filter((x) => x === id).length).toBeLessThanOrEqual(1);
  }
  const present = snapshots.map((s) => s.includes(id));
  const firstTrue = present.indexOf(true);
  if (firstTrue === -1) return;
  const lastTrue = present.lastIndexOf(true);
  for (let i = firstTrue; i <= lastTrue; i++) {
    expect(present[i]).toBe(true);
  }
}

async function ready(server: ReturnType<typeof fakeServer>) {
  const api = createInMemoryEntityApi({
    spec: notesSpec(server),
    queryClient: new QueryClient(),
  });
  const open = createLiveQueryCollection((q) =>
    q.from({ n: api.collection }).where(({ n }) => eq(n.done, false)),
  );
  const snapshots: string[][] = [];
  const record = () => snapshots.push(open.toArray.map((n: Note) => n.text));
  open.subscribeChanges(record);
  await api.collection.stateWhenReady();
  await open.preload();
  await sleep(50);
  record();
  return { api, open, snapshots, record };
}

describe("createInMemoryEntityApi", () => {
  it("inserts with a client-minted id and createdAt, once, without flicker", async () => {
    const server = fakeServer([note("s1", { text: "alpha" })]);
    const { api, open, snapshots, record } = await ready(server);

    const tx = api.actions.addNote({ text: "beta" });
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    const rows = open.toArray as Note[];
    expect(rows.map((n) => n.text).sort()).toEqual(["alpha", "beta"]);
    const beta = rows.find((n) => n.text === "beta")!;
    expect(beta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(beta.createdAt)).not.toBeNaN();
    expect(server.calls.add).toBe(1);
    expectNoFlicker(snapshots, "beta");
  });

  it("routes an update to the first verb whose `matches` accepts the changed fields", async () => {
    const server = fakeServer([note("s1")]);
    const { api } = await ready(server);

    await api.actions.tagNote({ id: "s1", tag: "home" }).isPersisted.promise;
    await api.actions.editNote({ id: "s1", text: "renamed" }).isPersisted
      .promise;
    await sleep(50);

    expect(server.calls).toEqual({ add: 0, finish: 0, edit: 1, tag: 1 });
    const row = api.collection.get("s1")!;
    expect(row.tag).toBe("home");
    expect(row.text).toBe("renamed");
  });

  it("removes a row the server reports as having left the working set, without flicker", async () => {
    const server = fakeServer([note("s1", { text: "alpha" }), note("s2", { text: "beta" })]);
    const { api, open, snapshots, record } = await ready(server);

    const tx = api.actions.finishNote({ id: "s1" });
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    expect(open.toArray.map((n: Note) => n.text)).toEqual(["beta"]);
    expect(api.collection.has("s1")).toBe(false);
    expect(server.calls.finish).toBe(1);
    expectNoFlicker(snapshots, "alpha");
  });

  it("exposes one action per verb, keyed by the verb's (outbox) name", async () => {
    const { api } = await ready(fakeServer([]));
    expect(Object.keys(api.actions).sort()).toEqual([
      "addNote",
      "editNote",
      "finishNote",
      "tagNote",
    ]);
    expect(api.offline).toBe(false);
  });
});

describe("reconcileWrites", () => {
  it("inserts every server row when the collection is empty", () => {
    expect(reconcileWrites([], [note("a"), note("b")])).toEqual([
      { type: "insert", value: note("a") },
      { type: "insert", value: note("b") },
    ]);
  });

  it("updates rows already present instead of re-inserting them", () => {
    expect(reconcileWrites(["a"], [note("a"), note("b")])).toEqual([
      { type: "update", value: note("a") },
      { type: "insert", value: note("b") },
    ]);
  });

  it("deletes keys the server no longer returns", () => {
    expect(reconcileWrites(["a", "b"], [note("a")])).toEqual([
      { type: "update", value: note("a") },
      { type: "delete", key: "b" },
    ]);
  });

  it("clears everything when the server list is empty", () => {
    expect(reconcileWrites(["a", "b"], [])).toEqual([
      { type: "delete", key: "a" },
      { type: "delete", key: "b" },
    ]);
  });

  it("emits no duplicate insert for a key that is already present", () => {
    const writes = reconcileWrites(["a"], [note("a")]);
    expect(writes.filter((w) => w.type === "insert")).toHaveLength(0);
  });
});
