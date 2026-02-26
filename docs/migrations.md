# Database Migrations

This project uses Drizzle ORM with Cloudflare Durable Objects SQLite. Migrations are bundled into the worker code and applied automatically at runtime.

## Overview

There are two separate databases with their own schemas and migrations:
- **UserDO** - User data (`apps/api/src/UserDO/db/`)
- **SessionDO** - Session data (`apps/api/src/SessionDO/db/`)

## Creating a Migration

### 1. Edit the schema

Modify the appropriate schema file in `apps/api/src/{UserDO,SessionDO}/db/schema.ts`.

### 2. Generate the migration

From the project root:

```bash
pnpm --filter @zero/api run db:generate
```

This generates:
- `drizzle/XXXX_migration_name.sql` - SQL statements
- `drizzle/meta/_journal.json` - Migration journal
- `drizzle/meta/XXXX_snapshot.json` - Schema snapshot
- `drizzle/migrations.js` - Auto-generated import bundle

**Why is migrations.js needed?** Cloudflare Durable Objects can't read files at runtime. Migrations must be bundled as ES module imports into the worker code. Drizzle Kit auto-generates this file.

### 3. Verify

Run `bin/ci` to ensure:
- Schema types match migrations
- Code compiles correctly
- Tests pass

## How Migrations Apply

Migrations run automatically when a Durable Object initializes:

```typescript
ctx.blockConcurrencyWhile(async () => {
  await migrate(this.db, migrations);
});
```

Each Durable Object instance tracks which migrations have been applied. New migrations run on first access after deployment.

## Migration Naming

Drizzle Kit auto-generates migration names with a sequential number and random suffix (e.g., `0006_fancy_swarm.sql`). **Do not rename migration files.** The `migrations.js` file is auto-generated from `_journal.json`, so renaming files will break the build.

## Troubleshooting

**"Migration not applied"**: Run `db:generate` again to regenerate `migrations.js`.

**"Column already exists"**: The migration may have already been applied. Check the Durable Object's internal migration tracking.
