CREATE TABLE `safe_import_execution_records` (
	`execution_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`execution_id`, `contact_id`),
	FOREIGN KEY (`execution_id`) REFERENCES `safe_import_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `safe_import_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`execution_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `safe_import_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `safe_import_executions_review_id_unique` ON `safe_import_executions` (`review_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `safe_import_executions_execution_key_unique` ON `safe_import_executions` (`execution_key`);--> statement-breakpoint
CREATE TABLE `safe_import_review_chunks` (
	`review_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`review_id`, `chunk_index`),
	FOREIGN KEY (`review_id`) REFERENCES `safe_import_reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `safe_import_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_safe_import_reviews_workspace` ON `safe_import_reviews` (`workspace_id`,`created_at`);