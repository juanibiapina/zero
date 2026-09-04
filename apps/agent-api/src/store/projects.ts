// Projects: the third entity of the todo app. A Project is a named,
// outcome-oriented container with a status, distinct from a Capture (untyped) and
// a Task (a dated next-action). Standalone from the agent's Store on purpose so
// it does not widen the agent's interface, and separate from DbCaptureStore /
// DbTaskStore because the entities have different verbs. See
// docs/entities/project.md.
//
// Slice A1 wires `add` and `list`; A2 adds `setStatus`; A3 adds `edit`
// (title/icon/description). The icon/description columns exist from A1's
// migration, so A3 needs no migration.

import { asc, eq, ne, type Database } from "do-orm";

import { projects } from "../UserDO/db/schema";

// The working status set. 'done' is terminal; the other four are working states.
export type ProjectStatus = "active" | "next" | "waiting" | "backlog" | "done";

export interface Project {
  id: string;
  title: string;
  // A single emoji. Defaults to 📁 at creation.
  icon: string;
  // Free-text notes; null when unset.
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
}

// The defaults a name-only create applies. Creation stays fast (just a title);
// icon/description/status are enriched later from the detail sheet.
const DEFAULT_ICON = "📁";
const DEFAULT_STATUS: ProjectStatus = "next";

// Fields a caller may override at creation. Creation normally passes none of
// these, so the store applies the defaults above.
export type ProjectDefaults = {
  icon?: string;
  description?: string | null;
  status?: ProjectStatus;
};

// The fields a later edit may change (title/icon/description). Status is its own
// verb (setStatus) because it has terminal semantics (done drops the row from
// the list). Only the present keys are written.
export type ProjectEdit = {
  title?: string;
  icon?: string;
  description?: string | null;
};

// Project a stored row back to the client-facing Project shape.
function toProject(row: {
  id: string;
  title: string;
  icon: string;
  description: string | null;
  status: string;
  createdAt: string;
}): Project {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    description: row.description,
    status: row.status as ProjectStatus,
    createdAt: row.createdAt,
  };
}

export class DbProjectStore {
  constructor(private db: Database) {}

  // The client mints the project id, so the add is exactly-once on the id alone:
  // a replay (a retried write after a lost ACK) re-sends the same id and gets the
  // already-stored row back instead of inserting a second one. `opts` may carry
  // icon/description/status, but a name-only create passes none, so the store
  // fills the defaults.
  add(id: string, title: string, opts: ProjectDefaults = {}): Project {
    const existingById = this.db.get(projects, { where: eq("id", id) });
    if (existingById) return toProject(existingById);
    const project: Project = {
      id,
      title,
      icon: opts.icon ?? DEFAULT_ICON,
      description: opts.description ?? null,
      status: opts.status ?? DEFAULT_STATUS,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(projects, project);
    return project;
  }

  // The working set: every non-'done' project, oldest first. 'done' is terminal
  // and drops out of the list (the client re-groups the four working statuses
  // into sections and animates the row out). The `projects_open` partial index
  // covers this filter.
  list(): Project[] {
    return this.db
      .all(projects, { where: ne("status", "done"), orderBy: asc("createdAt") })
      .map(toProject);
  }

  // Move a project to another status (including to/from the terminal 'done').
  // Returns the updated row, or null when no row has that id. One verb carries
  // every transition; the caller decides which of the five states to pass.
  setStatus(id: string, status: ProjectStatus): Project | null {
    this.db.update(projects, { status }, { where: eq("id", id) });
    const row = this.db.get(projects, { where: eq("id", id) });
    return row ? toProject(row) : null;
  }

  // Edit a project's title/icon/description. Only the present keys are written
  // (a partial update on the stable id, so a replayed offline edit re-applies
  // the same values harmlessly). Status is not editable here (setStatus owns
  // it). Returns the updated row, or null when no row has that id.
  edit(id: string, fields: ProjectEdit): Project | null {
    const patch: ProjectEdit = {};
    if (fields.title !== undefined) patch.title = fields.title;
    if (fields.icon !== undefined) patch.icon = fields.icon;
    if (fields.description !== undefined) patch.description = fields.description;
    if (Object.keys(patch).length > 0) {
      this.db.update(projects, patch, { where: eq("id", id) });
    }
    const row = this.db.get(projects, { where: eq("id", id) });
    return row ? toProject(row) : null;
  }
}
