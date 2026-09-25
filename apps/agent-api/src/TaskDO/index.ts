import { createMergeableStore, type MergeableStore } from "tinybase";
import { createDurableObjectSqlStoragePersister } from "tinybase/persisters/persister-durable-object-sql-storage";
import { WsServerDurableObject } from "tinybase/synchronizers/synchronizer-ws-server-durable-object";

import type { Task } from "../store/tasks";
import type { Env } from "../types";

// The per-account todo authority. Only fresh hermetic fixture accounts can
// connect during this slice; the real accounts continue to use UserDO.
export class TaskDO extends WsServerDurableObject<Env> {
  private tasksStore!: MergeableStore;
  private persister!: ReturnType<typeof createDurableObjectSqlStoragePersister>;
  private purging = false;

  override createPersister() {
    this.tasksStore = createMergeableStore();
    this.persister = createDurableObjectSqlStoragePersister(
      this.tasksStore,
      this.ctx.storage.sql,
      { mode: "fragmented", storagePrefix: "taskdo_" },
    );
    return this.persister;
  }

  isErased(): Promise<boolean> {
    if (this.purging) return Promise.resolve(true);
    return this.ctx.storage.get<boolean>("fixtureDeleted").then((deleted) => deleted === true);
  }

  private task(id: string): Task | null {
    if (!this.tasksStore.hasRow("tasks", id)) return null;
    const row = this.tasksStore.getRow("tasks", id);
    if (typeof row.text !== "string" || typeof row.createdAt !== "string") return null;
    return {
      id,
      text: row.text,
      createdAt: row.createdAt,
      showUpDate: typeof row.showUpDate === "string" ? row.showUpDate : null,
      completedAt: typeof row.completedAt === "string" ? row.completedAt : null,
      recurrence: null,
      recurrenceDate: null,
      projectId: null,
      sourceCaptureId: null,
      sortKey: typeof row.sortKey === "string" ? row.sortKey : null,
    };
  }

  listTasks(): Task[] {
    if (this.purging) return [];
    return Object.keys(this.tasksStore.getTable("tasks"))
      .map((id) => this.task(id))
      .filter((task): task is Task => task !== null && task.completedAt === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addTask(id: string, text: string, showUpDate: string | null): Promise<Task> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const existing = this.task(id);
    if (existing) return existing;
    this.tasksStore.setRow("tasks", id, {
      text,
      createdAt: new Date().toISOString(),
      ...(showUpDate ? { showUpDate } : {}),
    });
    await this.persister.save();
    return this.task(id)!;
  }

  async editTask(id: string, text: string): Promise<Task | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    if (!this.task(id)) return null;
    this.tasksStore.setCell("tasks", id, "text", text);
    await this.persister.save();
    return this.task(id);
  }

  // The TinyBase synchronizer has live listeners. Stop them and close sockets
  // before deleting SQLite, or a late auto-save can recreate deleted rows.
  async purge(lockFixture = false): Promise<void> {
    this.purging = true;
    try {
      for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Account erased");
      await this.persister.destroy();
      await this.ctx.storage.deleteAll();
      // Ordinary accounts have no TaskDO client yet. The fixture must keep
      // this one bit or an offline client could repopulate deleted Tasks.
      if (lockFixture) await this.ctx.storage.put("fixtureDeleted", true);
    } catch (error) {
      this.purging = false;
      throw error;
    }
  }

  reset(): void {
    this.ctx.abort("task data deleted");
  }
}
