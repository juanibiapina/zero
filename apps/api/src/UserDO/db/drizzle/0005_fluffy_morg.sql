ALTER TABLE `projects` ADD `fullName` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `description` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `defaultBranch` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `isPrivate` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `archived` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `updatedAt` text NOT NULL DEFAULT '';