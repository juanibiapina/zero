const keyFor = (accountId: string) => `zero.todo.last-sync.${accountId}`;

export function loadLastSync(accountId: string): string | null {
  try {
    const value = localStorage.getItem(keyFor(accountId));
    return value && Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export function saveLastSync(accountId: string, value: string): void {
  try {
    localStorage.setItem(keyFor(accountId), value);
  } catch {
    // Optional diagnostics do not affect the durable local replica.
  }
}
