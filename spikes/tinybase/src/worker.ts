import { createMergeableStore, type MergeableStore } from 'tinybase';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import {
  WsServerDurableObject,
} from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';

// This Worker is a local experiment. These fixed tokens are NOT authentication
// for production; the real Worker must verify Clerk and derive the DO ID there.
type Env = { PROOF_STORES: DurableObjectNamespace<ProofStoreDO> };
const accountFor = (request: Request) => {
  switch (request.headers.get('authorization')) {
    case 'Bearer proof-user-a': return 'a';
    case 'Bearer proof-user-b': return 'b';
    default: return null;
  }
};

type Project = { id: string; title: string };
type Task = { id: string; text: string; projectId: string; completed: boolean };

export class ProofStoreDO extends WsServerDurableObject<Env> {
  declare private todoStore: MergeableStore;
  declare private todoPersister: ReturnType<typeof createDurableObjectSqlStoragePersister>;

  override createPersister() {
    this.todoStore = createMergeableStore();
    this.todoPersister = createDurableObjectSqlStoragePersister(
      this.todoStore,
      this.ctx.storage.sql,
      { mode: 'fragmented', storagePrefix: 'tinybase_proof_' },
    );
    return this.todoPersister;
  }

  async putProject(project: Project): Promise<void> {
    this.todoStore.setRow('projects', project.id, { title: project.title });
    await this.todoPersister.save();
  }

  async putTask(task: Task): Promise<void> {
    if (!this.todoStore.hasRow('projects', task.projectId)) {
      throw new Error('Project does not exist');
    }
    this.todoStore.setRow('tasks', task.id, {
      text: task.text,
      projectId: task.projectId,
      completed: task.completed,
    });
    await this.todoPersister.save();
  }

  getTodos() {
    return JSON.parse(JSON.stringify({
      projects: this.todoStore.getTable('projects'),
      tasks: this.todoStore.getTable('tasks'),
    })) as { projects: Record<string, Project>; tasks: Record<string, Task> };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/health') {
      return new Response('ok');
    }
    const account = accountFor(request);
    if (!account) return new Response('Unauthorized', { status: 401 });
    const stub = env.PROOF_STORES.get(env.PROOF_STORES.idFromName(account));
    const url = new URL(request.url);
    if (url.pathname === '/sync') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Upgrade required', { status: 426 });
      }
      url.pathname = `/${account}`;
      return stub.fetch(new Request(url, request));
    }
    if (url.pathname === '/api/state' && request.method === 'GET') {
      return Response.json(await stub.getTodos());
    }
    if (url.pathname === '/api/projects' && request.method === 'POST') {
      const project = await request.json() as Project;
      if (!project.id || !project.title) return new Response('Invalid project', { status: 400 });
      await stub.putProject(project);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/api/tasks' && request.method === 'POST') {
      const task = await request.json() as Task;
      if (!task.id || !task.text || !task.projectId || typeof task.completed !== 'boolean') {
        return new Response('Invalid task', { status: 400 });
      }
      try {
        await stub.putTask(task);
      } catch {
        return new Response('Project does not exist', { status: 409 });
      }
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  },
};
