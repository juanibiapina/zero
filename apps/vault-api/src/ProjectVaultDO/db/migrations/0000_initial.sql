-- Encrypted DEK + metadata (single row per DO)
CREATE TABLE `vault_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);

-- Environments (no project_id — the DO IS the project)
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE UNIQUE INDEX `environments_name_unique` ON `environments` (`name`);

-- Encrypted secrets
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL REFERENCES `environments`(`id`) ON DELETE CASCADE,
	`key_encrypted` text NOT NULL,
	`key_hash` text NOT NULL,
	`value_encrypted` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE UNIQUE INDEX `secrets_env_keyhash_unique` ON `secrets` (`environment_id`, `key_hash`);
