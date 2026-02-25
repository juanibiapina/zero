CREATE TABLE `session_meta` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`containerName` text NOT NULL,
	`projectOwner` text NOT NULL,
	`projectRepo` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`createdAt` text NOT NULL
);
