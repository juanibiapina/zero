-- Todos: the capture list for the parallel todo app (the Todoist replacement).
-- Standalone from the agent's tables; owned by DbTodoStore, not the agent Store.
-- No done/scheduled-date/order columns yet: later increments add them via their
-- own migrations. `id` is a UUID; `createdAt` is capture time and list order.
CREATE TABLE "todos" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);
