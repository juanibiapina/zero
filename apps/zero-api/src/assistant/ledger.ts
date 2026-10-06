export interface ChatRef {
  chatId: number;
  topicId: number;
}

export interface ChatRow extends ChatRef {
  conversationId: string;
  session: string;
  consolidatedThrough: number;
  sentThrough: number;
}

export type OperationKind = "chat" | "learn" | "job";

export interface OperationRow {
  operationId: string;
  kind: OperationKind;
  session: string;
  createdAt: number;
}

export interface Ledger {
  chat(chat: ChatRef): ChatRow | null;
  chatBySession(session: string): ChatRow | null;
  chats(): ChatRow[];
  addChat(row: Omit<ChatRow, "consolidatedThrough" | "sentThrough">): void;
  setSentThrough(session: string, entryId: number): void;
  setConsolidatedThrough(session: string, entryId: number): void;
  claimDelivery(entryId: number, blockIndex: number): boolean;
  addOperation(row: OperationRow): void;
  operations(): OperationRow[];
  finishOperation(operationId: string): void;
  jobSession(jobId: string): string | null;
  addJobSession(jobId: string, session: string): void;
  getValue<T>(key: string): T | null;
  putValue(key: string, value: unknown): void;
}

export const createMemoryLedger = (): Ledger => {
  const chats = new Map<string, ChatRow>();
  const claims = new Set<string>();
  const operations = new Map<string, OperationRow>();
  const jobs = new Map<string, string>();
  const values = new Map<string, string>();
  const key = (chat: ChatRef) => `${chat.chatId}:${chat.topicId}`;
  const bySession = (session: string) =>
    [...chats.values()].find((row) => row.session === session) ?? null;
  return {
    chat: (chat) => chats.get(key(chat)) ?? null,
    chatBySession: bySession,
    chats: () => [...chats.values()],
    addChat: (row) =>
      void chats.set(key(row), { ...row, consolidatedThrough: 0, sentThrough: 0 }),
    setSentThrough: (session, entryId) => {
      const row = bySession(session);
      if (row && entryId > row.sentThrough) row.sentThrough = entryId;
    },
    setConsolidatedThrough: (session, entryId) => {
      const row = bySession(session);
      if (row && entryId > row.consolidatedThrough) row.consolidatedThrough = entryId;
    },
    claimDelivery: (entryId, blockIndex) => {
      const claim = `${entryId}:${blockIndex}`;
      if (claims.has(claim)) return false;
      claims.add(claim);
      return true;
    },
    addOperation: (row) => {
      if (!operations.has(row.operationId)) operations.set(row.operationId, row);
    },
    operations: () =>
      [...operations.values()].sort((a, b) => a.createdAt - b.createdAt),
    finishOperation: (operationId) => void operations.delete(operationId),
    jobSession: (jobId) => jobs.get(jobId) ?? null,
    addJobSession: (jobId, session) => void jobs.set(jobId, session),
    getValue: <T>(name: string) => {
      const value = values.get(name);
      return value === undefined ? null : (JSON.parse(value) as T);
    },
    putValue: (name, value) => void values.set(name, JSON.stringify(value)),
  };
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS assistant_chats (
    chat_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    session TEXT NOT NULL UNIQUE,
    consolidated_through INTEGER NOT NULL DEFAULT 0,
    sent_through INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, topic_id)
  )`,
  `CREATE TABLE IF NOT EXISTS assistant_deliveries (
    entry_id INTEGER NOT NULL,
    block_index INTEGER NOT NULL,
    PRIMARY KEY (entry_id, block_index)
  )`,
  `CREATE TABLE IF NOT EXISTS assistant_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    session TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assistant_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    session TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assistant_values (
    name TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,
];

type Row = Record<string, SqlStorageValue>;

const text = (value: SqlStorageValue): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

const toChat = (row: Row): ChatRow => ({
  chatId: Number(row.chat_id),
  topicId: Number(row.topic_id),
  conversationId: text(row.conversation_id),
  session: text(row.session),
  consolidatedThrough: Number(row.consolidated_through),
  sentThrough: Number(row.sent_through),
});

export const createSqlLedger = (sql: SqlStorage): Ledger => {
  for (const statement of SCHEMA) sql.exec(statement);
  const all = (query: string, ...params: SqlStorageValue[]): Row[] =>
    sql.exec<Row>(query, ...params).toArray();
  const one = (query: string, ...params: SqlStorageValue[]): Row | null =>
    all(query, ...params)[0] ?? null;
  return {
    chat: (chat) => {
      const row = one(
        "SELECT * FROM assistant_chats WHERE chat_id = ? AND topic_id = ?",
        chat.chatId,
        chat.topicId,
      );
      return row ? toChat(row) : null;
    },
    chatBySession: (session) => {
      const row = one("SELECT * FROM assistant_chats WHERE session = ?", session);
      return row ? toChat(row) : null;
    },
    chats: () => all("SELECT * FROM assistant_chats").map(toChat),
    addChat: (row) =>
      void sql.exec(
        "INSERT OR IGNORE INTO assistant_chats (chat_id, topic_id, conversation_id, session) VALUES (?, ?, ?, ?)",
        row.chatId,
        row.topicId,
        row.conversationId,
        row.session,
      ),
    setSentThrough: (session, entryId) =>
      void sql.exec(
        "UPDATE assistant_chats SET sent_through = MAX(sent_through, ?) WHERE session = ?",
        entryId,
        session,
      ),
    setConsolidatedThrough: (session, entryId) =>
      void sql.exec(
        "UPDATE assistant_chats SET consolidated_through = MAX(consolidated_through, ?) WHERE session = ?",
        entryId,
        session,
      ),
    claimDelivery: (entryId, blockIndex) =>
      sql.exec(
        "INSERT OR IGNORE INTO assistant_deliveries (entry_id, block_index) VALUES (?, ?)",
        entryId,
        blockIndex,
      ).rowsWritten > 0,
    addOperation: (row) =>
      void sql.exec(
        "INSERT OR IGNORE INTO assistant_operations (operation_id, kind, session, created_at) VALUES (?, ?, ?, ?)",
        row.operationId,
        row.kind,
        row.session,
        row.createdAt,
      ),
    operations: () =>
      all("SELECT * FROM assistant_operations ORDER BY created_at").map((row) => ({
        operationId: text(row.operation_id),
        kind: text(row.kind) as OperationKind,
        session: text(row.session),
        createdAt: Number(row.created_at),
      })),
    finishOperation: (operationId) =>
      void sql.exec(
        "DELETE FROM assistant_operations WHERE operation_id = ?",
        operationId,
      ),
    jobSession: (jobId) => {
      const row = one("SELECT session FROM assistant_jobs WHERE job_id = ?", jobId);
      return row ? text(row.session) : null;
    },
    addJobSession: (jobId, session) =>
      void sql.exec(
        "INSERT OR IGNORE INTO assistant_jobs (job_id, session) VALUES (?, ?)",
        jobId,
        session,
      ),
    getValue: <T>(name: string) => {
      const row = one("SELECT value FROM assistant_values WHERE name = ?", name);
      return row ? (JSON.parse(text(row.value)) as T) : null;
    },
    putValue: (name, value) =>
      void sql.exec(
        "INSERT INTO assistant_values (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
        name,
        JSON.stringify(value),
      ),
  };
};
