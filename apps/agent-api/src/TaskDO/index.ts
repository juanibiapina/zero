import { createMergeableStore, type MergeableStore } from "tinybase";
import { createDurableObjectSqlStoragePersister } from "tinybase/persisters/persister-durable-object-sql-storage";
import { WsServerDurableObject } from "tinybase/synchronizers/synchronizer-ws-server-durable-object";

import type { Task } from "../store/tasks";
import type { Project, ProjectDefaults } from "../store/projects";
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

  private project(id: string): Project | null {
    if (!this.tasksStore.hasRow("projects", id)) return null;
    const row = this.tasksStore.getRow("projects", id);
    if (row.deletedAt || typeof row.title !== "string" || typeof row.createdAt !== "string") return null;
    if (row.state !== "in-play" && row.state !== "backlog" && row.state !== "done") return null;
    return {
      id,
      title: row.title,
      icon: typeof row.icon === "string" ? row.icon : "📁",
      description: typeof row.description === "string" ? row.description : null,
      state: row.state,
      createdAt: row.createdAt,
      sourceCaptureId: typeof row.sourceCaptureId === "string" ? row.sourceCaptureId : null,
    };
  }

  listProjects(): Project[] {
    if (this.purging) return [];
    return Object.keys(this.tasksStore.getTable("projects"))
      .map((id) => this.project(id))
      .filter((project): project is Project => project !== null && project.state !== "done")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addProject(id: string, title: string, opts: ProjectDefaults = {}): Promise<Project | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    if (this.tasksStore.hasRow("projects", id)) return this.project(id);
    this.tasksStore.setRow("projects", id, {
      title,
      icon: opts.icon ?? "📁",
      state: opts.state ?? "in-play",
      createdAt: new Date().toISOString(),
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.sourceCaptureId ? { sourceCaptureId: opts.sourceCaptureId } : {}),
    });
    await this.persister.save();
    return this.project(id);
  }

  async deleteProject(id: string): Promise<{ tasks: number; conditions: number; afters: number }> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    let tasks = 0;
    this.tasksStore.transaction(() => {
      if (!this.project(id)) return;
      this.tasksStore.setCell("projects", id, "deletedAt", new Date().toISOString());
      for (const [taskId, row] of Object.entries(this.tasksStore.getTable("tasks"))) {
        if (row.projectId === id) {
          this.tasksStore.delRow("tasks", taskId);
          tasks++;
        }
      }
    });
    await this.persister.save();
    return { tasks, conditions: 0, afters: 0 };
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
      projectId: typeof row.projectId === "string" && this.project(row.projectId) ? row.projectId : null,
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

  listRecoveries(): Array<{ taskId: string; projectId: string; reason: "missing-project" | "deleted-project" }> {
    if (this.purging) return [];
    return Object.entries(this.tasksStore.getTable("tasks")).flatMap(([taskId, row]) => {
      if (typeof row.projectId !== "string" || this.project(row.projectId)) return [];
      const rawProject = this.tasksStore.getRow("projects", row.projectId);
      return [{
        taskId,
        projectId: row.projectId,
        reason: rawProject.deletedAt ? "deleted-project" as const : "missing-project" as const,
      }];
    });
  }

  async addTask(id: string, text: string, showUpDate: string | null, projectId: string | null = null): Promise<Task | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const existing = this.task(id);
    if (existing) return existing;
    if (projectId !== null && !this.project(projectId)) return null;
    this.tasksStore.setRow("tasks", id, {
      text,
      createdAt: new Date().toISOString(),
      ...(showUpDate ? { showUpDate } : {}),
      ...(projectId ? { projectId } : {}),
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
