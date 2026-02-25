CREATE TABLE `github_installations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installationId` integer NOT NULL,
	`accountLogin` text NOT NULL,
	`accountType` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_installationId_unique` ON `github_installations` (`installationId`);--> statement-breakpoint
CREATE TABLE `pkce_verifiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state` text NOT NULL,
	`verifier` text NOT NULL,
	`provider` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pkce_verifiers_state_unique` ON `pkce_verifiers` (`state`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`projectDOId` text NOT NULL,
	`installationId` integer,
	`defaultProvider` text,
	`defaultModel` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`credentialType` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`expiresAt` text,
	`apiKey` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
