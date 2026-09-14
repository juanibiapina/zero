// Projects: the third entity of the todo app. A Project is a named,
// outcome-oriented container with lifecycle state, distinct from a Capture and
// a Task. Standalone from the agent's Store on purpose so
// it does not widen the agent's interface, and separate from DbCaptureStore /
// DbTaskStore because the entities have different verbs (do-orm is the shared
// layer; a store holds only domain verbs, see docs/storage.md). See
// docs/entities/project.md.

import { asc, eq, ne, type Database } from "do-orm";

import { projects } from "../UserDO/db/schema";

// Persisted lifecycle only. Active, Next, and Waiting are calculated by clients.
export type ProjectState = "in-play" | "backlog" | "done";

export interface Project {
  id: string;
  title: string;
  // A single emoji. Defaults to 📁 at creation.
  icon: string;
  // Free-text notes; null when unset.
  description: string | null;
  state: ProjectState;
  createdAt: string;
  // The capture this project was refined from, or null.
  sourceCaptureId: string | null;
}

// The defaults a name-only create applies. Creation stays fast (just a title);
// icon/description are enriched later; display status is calculated.
const DEFAULT_ICON = "📁";
const DEFAULT_STATE: ProjectState = "in-play";

// Fields a caller may override at creation. Creation normally passes none of
// these, so the store applies the defaults above.
export type ProjectDefaults = {
  icon?: string;
  description?: string | null;
  state?: ProjectState;
  sourceCaptureId?: string | null;
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
  state: string;
  createdAt: string;
  sourceCaptureId: string | null;
}): Project {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    description: row.description,
    state: row.state as ProjectState,
    createdAt: row.createdAt,
    sourceCaptureId: row.sourceCaptureId,
  };
}

export class DbProjectStore {
  constructor(private db: Database) {}

  // The client mints the project id, so the add is exactly-once on the id alone:
  // a replay (a retried write after a lost ACK) re-sends the same id and gets the
  // already-stored row back instead of inserting a second one. `opts` may carry
  // icon/description/state, but a name-only create passes none, so the store
  // fills the defaults.
  add(id: string, title: string, opts: ProjectDefaults = {}): Project {
    const existingById = this.db.get(projects, { where: eq("id", id) });
    if (existingById) return toProject(existingById);
    const project: Project = {
      id,
      title,
      icon: opts.icon ?? DEFAULT_ICON,
      description: opts.description ?? null,
      state: opts.state ?? DEFAULT_STATE,
      createdAt: new Date().toISOString(),
      sourceCaptureId: opts.sourceCaptureId ?? null,
    };
    this.db.insert(projects, project);
    return project;
  }

  // The working set: every non-Done project, oldest first. Done is terminal
  // and drops out of the list (the client calculates and groups display statuses
  // into sections and animates the row out). The `projects_open` partial index
  // covers this filter.
  list(): Project[] {
    return this.db
      .all(projects, { where: ne("state", "done"), orderBy: asc("createdAt") })
      .map(toProject);
  }

  // Persist one of the three lifecycle states. Returns the updated row, or null
  // when no row has that id.
  setState(id: string, state: ProjectState): Project | null {
    this.db.update(projects, { state }, { where: eq("id", id) });
    const row = this.db.get(projects, { where: eq("id", id) });
    return row ? toProject(row) : null;
  }

  // Edit a project's title/icon/description. Only the present keys are written
  // (a partial update on the stable id, so a replayed offline edit re-applies
  // the same values harmlessly). State is not editable here (`setState` owns
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

  // Permanently remove a project by id. Distinct from setState('done'), which
  // keeps the row (out of the working list) — delete hard-removes it. Idempotent
  // on the id: deleting a missing project is a no-op, so a replayed offline
  // delete (a retry after a lost ACK) is safe. Returns whether a row existed.
  delete(id: string): boolean {
    const existing = this.db.get(projects, { where: eq("id", id) });
    if (!existing) return false;
    this.db.delete(projects, { where: eq("id", id) });
    return true;
  }
}
