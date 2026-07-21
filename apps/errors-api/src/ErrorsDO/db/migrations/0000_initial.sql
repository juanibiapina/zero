-- One row per distinct fingerprint (the grouped bug)
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`project` text NOT NULL,
	`title` text NOT NULL,
	`level` text NOT NULL,
	`status` text NOT NULL,
	`count` integer NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
CREATE UNIQUE INDEX `issues_fingerprint_unique` ON `issues` (`fingerprint`);

-- Individual occurrences, capped and pruned (keep newest N per issue)
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL REFERENCES `issues`(`id`) ON DELETE CASCADE,
	`message` text NOT NULL,
	`stack` text,
	`context_json` text,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE INDEX `events_issue_id_idx` ON `events` (`issue_id`);
