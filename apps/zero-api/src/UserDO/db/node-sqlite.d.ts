// The slice of Node's built-in SQLite the migration tests use. The package
// compiles against Workers types, which do not include Node's modules.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): { all(): Record<string, unknown>[] };
  }
}
