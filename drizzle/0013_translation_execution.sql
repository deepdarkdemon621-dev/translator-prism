-- ARCH-002 additive execution schema. No data is deleted and the
-- (paragraph_id, lang) unique index is intentionally NOT created here; it is
-- gated behind migration 0014 after production duplicates reach zero.
ALTER TABLE `translations` ADD COLUMN `claimed_by` text;
--> statement-breakpoint
ALTER TABLE `translations` ADD COLUMN `lease_expires_at` text;
--> statement-breakpoint
CREATE TABLE `translation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_effort` text,
	`prompt_version` text NOT NULL,
	`worker_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`claimed_count` integer DEFAULT 0 NOT NULL,
	`done_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `translation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`translation_id` text NOT NULL,
	`run_id` text,
	`legacy_translation_id` text,
	`provider` text,
	`model` text,
	`reasoning_effort` text,
	`prompt_version` text NOT NULL,
	`source_hash` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`quality_codes` text,
	`error_message` text,
	`tokens_used` integer,
	`is_active` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`translation_id`) REFERENCES `translations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `translation_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_translation_attempts_translation_created`
ON `translation_attempts` (`translation_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_translation_attempts_run`
ON `translation_attempts` (`run_id`);
--> statement-breakpoint
-- At most one active (website-canonical) attempt per translation row.
CREATE UNIQUE INDEX IF NOT EXISTS `idx_translation_attempts_active`
ON `translation_attempts` (`translation_id`) WHERE `is_active` = 1;
--> statement-breakpoint
-- Lease reclaim path: status='processing' AND lease_expires_at < now.
CREATE INDEX IF NOT EXISTS `idx_translations_status_lease`
ON `translations` (`status`, `lease_expires_at`);
