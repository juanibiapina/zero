CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sessionDOId` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_sessionDOId_unique` ON `sessions` (`sessionDOId`);