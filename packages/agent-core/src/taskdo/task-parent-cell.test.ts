import { createMergeableStore, type MergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { keepTaskParentsMigrated, parentCellValue, readParentCell } from "./task-parent-cell";

let clock = Date.now() - 3_600_000;
const tick = () => { clock += 1000; };
const store = (id: string) => createMergeableStore(id, () => clock);
const parentOf = (s: MergeableStore, id = "t") => readParentCell(s.getRow("tasks", id));
const sync = (a: MergeableStore, b: MergeableStore) => { a.merge(b); b.merge(a); };

describe("task parent cell migration", () => {
  it("turns a legacy Project parent into the parent cell", () => {
    const s = store("s");
    s.setRow("tasks", "t", { text: "Task", projectId: "p1" });

    keepTaskParentsMigrated(s);

    expect(parentOf(s)).toEqual({ kind: "project", projectId: "p1" });
    expect(s.getRow("tasks", "t")).toEqual({ text: "Task", parent: parentCellValue({ kind: "project", projectId: "p1" }) });
  });

  it("turns a legacy restock Task into a Medicine parent", () => {
    const s = store("s");
    s.setRow("tasks", "t", { text: "Buy", medicineId: "m1", role: "restock" });

    keepTaskParentsMigrated(s);

    expect(parentOf(s)).toEqual({ kind: "medicine", medicineId: "m1", role: "restock" });
    expect(s.getCellIds("tasks", "t")).toEqual(["text", "parent"]);
  });

  it("keeps the Project when a row has both legacy parents", () => {
    const s = store("s");
    s.setRow("tasks", "t", { text: "Task", projectId: "p1", medicineId: "m1", role: "restock" });

    keepTaskParentsMigrated(s);

    expect(parentOf(s)).toEqual({ kind: "project", projectId: "p1" });
  });

  it("changes nothing on a second run", () => {
    const s = store("s");
    s.setRow("tasks", "t", { text: "Task", projectId: "p1" });
    keepTaskParentsMigrated(s);
    const hashes = s.getMergeableContentHashes();

    tick();
    keepTaskParentsMigrated(s);

    expect(s.getMergeableContentHashes()).toEqual(hashes);
  });

  it("keeps a Task loose when a stale replica still holds its old Project", () => {
    const server = store("server");
    server.setRow("tasks", "t", { text: "Task", projectId: "p1" });
    const phone = store("phone");
    phone.merge(server);
    tick();
    server.delCell("tasks", "t", "projectId");

    tick();
    keepTaskParentsMigrated(server);
    keepTaskParentsMigrated(phone);
    sync(server, phone);

    expect(parentOf(server)).toBeNull();
    expect(parentOf(phone)).toBeNull();
  });

  it("keeps a move made after the server migrated when a stale replica migrates later", () => {
    const server = store("server");
    server.setRow("tasks", "t", { text: "Task", projectId: "p1" });
    const phone = store("phone");
    phone.merge(server);
    tick();
    keepTaskParentsMigrated(server);
    tick();
    server.setCell("tasks", "t", "parent", parentCellValue({ kind: "project", projectId: "p2" }));

    tick();
    keepTaskParentsMigrated(phone);
    sync(server, phone);

    expect(parentOf(phone)).toEqual({ kind: "project", projectId: "p2" });
    expect(parentOf(server)).toEqual({ kind: "project", projectId: "p2" });
  });

  it("keeps an offline legacy move that is newer than the server's parent", () => {
    const server = store("server");
    server.setRow("tasks", "t", { text: "Task", projectId: "p1" });
    const phone = store("phone");
    phone.merge(server);
    tick();
    phone.setCell("tasks", "t", "projectId", "p2");
    tick();
    keepTaskParentsMigrated(server);

    tick();
    keepTaskParentsMigrated(phone);
    sync(server, phone);

    expect(parentOf(server)).toEqual({ kind: "project", projectId: "p2" });
    expect(server.getCellIds("tasks", "t")).toEqual(["text", "parent"]);
  });

  it("migrates legacy cells that arrive after it is installed", () => {
    const server = store("server");
    keepTaskParentsMigrated(server);
    const oldApp = store("old");
    oldApp.setRow("tasks", "t", { text: "Task", medicineId: "m1" });

    server.merge(oldApp);

    expect(parentOf(server)).toEqual({ kind: "medicine", medicineId: "m1", role: null });
    expect(server.getCellIds("tasks", "t")).toEqual(["text", "parent"]);
  });

  it("stops migrating once uninstalled", () => {
    const s = store("s");
    keepTaskParentsMigrated(s)();

    s.setRow("tasks", "t", { text: "Task", projectId: "p1" });

    expect(s.getCell("tasks", "t", "projectId")).toBe("p1");
  });
});
