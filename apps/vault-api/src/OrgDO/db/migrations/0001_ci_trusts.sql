-- Trusted CI workloads: which GitHub repository may exchange an OIDC token for
-- a short-lived credential in this org. Matched on immutable ids, never names.
CREATE TABLE `ci_trusts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`owner_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`repository` text NOT NULL,
	`ref` text,
	`environment` text,
	`allowed_events` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL
);
CREATE UNIQUE INDEX `ci_trusts_repo_unique` ON `ci_trusts` (`provider`, `owner_id`, `repo_id`);
