CREATE TABLE `project_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_settings_key_unique` ON `project_settings` (`key`);--> statement-breakpoint
CREATE TABLE `session_index` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sessionDOId` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
