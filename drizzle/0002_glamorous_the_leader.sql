CREATE TABLE `duplicate_review_decisions` (
	`workspace_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`decision` text NOT NULL,
	`primary_record_key` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `connector_id`, `cluster_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `duplicate_scan_clusters` (
	`scan_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`band` text NOT NULL,
	`confidence` integer NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`scan_id`, `cluster_id`),
	FOREIGN KEY (`scan_id`) REFERENCES `duplicate_scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `duplicate_scan_records` (
	`scan_id` text NOT NULL,
	`record_key` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`scan_id`, `record_key`),
	FOREIGN KEY (`scan_id`) REFERENCES `duplicate_scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `duplicate_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`status` text NOT NULL,
	`cursor_json` text,
	`records_scanned` integer DEFAULT 0 NOT NULL,
	`pages_scanned` integer DEFAULT 0 NOT NULL,
	`candidates_compared` integer DEFAULT 0 NOT NULL,
	`source_complete` integer DEFAULT false NOT NULL,
	`analysis_warnings_json` text DEFAULT '[]' NOT NULL,
	`rule_version` text NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_scans_workspace_created` ON `duplicate_scans` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_duplicate_scans_one_active` ON `duplicate_scans` (`workspace_id`,`connector_id`) WHERE "duplicate_scans"."status" = 'scanning';