import { safeRandomUUID } from '@tanstack/db';

export type TodoWorkspaceDescriptor = {
  version: 1;
  databaseName: string;
  binding:
    | { kind: 'unbound' }
    | { kind: 'bound'; accountId: string };
};

type TodoWorkspaceStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type CreateTodoWorkspaceRegistryOptions = {
  storage: TodoWorkspaceStorage;
  storageKey: string;
  createWorkspaceId?: () => string;
};

export class TodoWorkspaceAccessError extends Error {
  constructor(
    readonly code: 'locked' | 'account-mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'TodoWorkspaceAccessError';
  }
}

function assertAccountIdentity(accountId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) {
    throw new Error('Invalid account identity');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDescriptor(value: string): TodoWorkspaceDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Cannot open saved todo workspace: metadata is invalid');
  }
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || typeof parsed.databaseName !== 'string'
    || !/^taskdo-(?:fixture|workspace)-[a-zA-Z0-9_-]+\.sqlite$/.test(parsed.databaseName)
    || !isRecord(parsed.binding)
  ) {
    throw new Error('Cannot open saved todo workspace: metadata is invalid');
  }
  if (parsed.binding.kind === 'unbound') {
    if (!parsed.databaseName.startsWith('taskdo-workspace-')) {
      throw new Error('Cannot open saved todo workspace: metadata is invalid');
    }
    return {
      version: 1,
      databaseName: parsed.databaseName,
      binding: { kind: 'unbound' },
    };
  }
  if (
    parsed.binding.kind !== 'bound'
    || typeof parsed.binding.accountId !== 'string'
    || !/^[a-zA-Z0-9_-]+$/.test(parsed.binding.accountId)
  ) {
    throw new Error('Cannot open saved todo workspace: metadata is invalid');
  }
  if (
    parsed.databaseName.startsWith('taskdo-fixture-')
    && parsed.databaseName !== `taskdo-fixture-${parsed.binding.accountId}.sqlite`
  ) {
    throw new Error('Cannot open saved todo workspace: metadata is invalid');
  }
  return {
    version: 1,
    databaseName: parsed.databaseName,
    binding: { kind: 'bound', accountId: parsed.binding.accountId },
  };
}

export function createTodoWorkspaceRegistry({
  storage,
  storageKey,
  createWorkspaceId = safeRandomUUID,
}: CreateTodoWorkspaceRegistryOptions) {
  let tail: Promise<void> = Promise.resolve();

  const resolveSignedInAccount = async (
    accountId: string,
  ): Promise<TodoWorkspaceDescriptor> => {
    assertAccountIdentity(accountId);
    const stored = await storage.getItem(storageKey);
    if (stored === null) {
      const descriptor: TodoWorkspaceDescriptor = {
        version: 1,
        databaseName: `taskdo-fixture-${accountId}.sqlite`,
        binding: { kind: 'bound', accountId },
      };
      await storage.setItem(storageKey, JSON.stringify(descriptor));
      return descriptor;
    }
    const descriptor = parseDescriptor(stored);
    if (descriptor.binding.kind === 'unbound') {
      const bound: TodoWorkspaceDescriptor = {
        ...descriptor,
        binding: { kind: 'bound', accountId },
      };
      await storage.setItem(storageKey, JSON.stringify(bound));
      return bound;
    }
    if (descriptor.binding.accountId !== accountId) {
      throw new TodoWorkspaceAccessError(
        'account-mismatch',
        'Todo workspace belongs to a different account',
      );
    }
    return descriptor;
  };

  const resolveGuest = async (): Promise<TodoWorkspaceDescriptor> => {
    const stored = await storage.getItem(storageKey);
    if (stored === null) {
      const workspaceId = createWorkspaceId();
      assertAccountIdentity(workspaceId);
      const descriptor: TodoWorkspaceDescriptor = {
        version: 1,
        databaseName: `taskdo-workspace-${workspaceId}.sqlite`,
        binding: { kind: 'unbound' },
      };
      await storage.setItem(storageKey, JSON.stringify(descriptor));
      return descriptor;
    }
    const descriptor = parseDescriptor(stored);
    if (descriptor.binding.kind !== 'unbound') {
      throw new TodoWorkspaceAccessError(
        'locked',
        'Cannot open a bound todo workspace while signed out',
      );
    }
    return descriptor;
  };

  return {
    forGuest(): Promise<TodoWorkspaceDescriptor> {
      const operation = tail.then(resolveGuest);
      tail = operation.then(() => {}, () => {});
      return operation;
    },
    forSignedInAccount(accountId: string): Promise<TodoWorkspaceDescriptor> {
      const operation = tail.then(() => resolveSignedInAccount(accountId));
      tail = operation.then(() => {}, () => {});
      return operation;
    },
    forget(expected: TodoWorkspaceDescriptor): Promise<void> {
      const operation = tail.then(async () => {
        const stored = await storage.getItem(storageKey);
        if (stored === null) return;
        const descriptor = parseDescriptor(stored);
        if (JSON.stringify(descriptor) !== JSON.stringify(expected)) {
          throw new Error('Saved todo workspace changed during sign out');
        }
        await storage.removeItem(storageKey);
      });
      tail = operation.then(() => {}, () => {});
      return operation;
    },
  };
}

export type TodoWorkspaceRegistry = ReturnType<typeof createTodoWorkspaceRegistry>;
