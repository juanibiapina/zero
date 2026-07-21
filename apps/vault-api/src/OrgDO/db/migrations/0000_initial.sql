-- Projects registry (the DO IS the org; no org_id column)
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE UNIQUE INDEX `projects_name_unique` ON `projects` (`name`);

-- Org-scoped API key metadata (auth lookup via KV; metadata here)
CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`suffix` text NOT NULL,
	`label` text,
	`encrypted_key` text,
	`created_at` text NOT NULL
);
CREATE UNIQUE INDEX `api_keys_keyhash_unique` ON `api_keys` (`key_hash`);
