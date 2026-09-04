// Projects: the third entity of the todo app. A Project is a named,
// outcome-oriented container with a status, distinct from a Capture (untyped) and
// a Task (a dated next-action). Standalone from the agent's Store on purpose so
// it does not widen the agent's interface, and separate from DbCaptureStore /
// DbTaskStore because the entities have different verbs. See
// docs/entities/project.md.
//
// Slice A1 wires only `add` and `list`; `setStatus` (A2) and `edit` (A3) land
// later. The status column exists now (default 'next') so those slices need no
// migration.

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
}
