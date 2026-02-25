CREATE TABLE `session_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seq` integer NOT NULL,
	`containerSeq` integer,
	`source` text NOT NULL,
	`eventType` text NOT NULL,
	`data` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_events_seq_unique` ON `session_events` (`seq`);