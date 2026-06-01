ALTER TABLE `translations` ADD COLUMN `retry_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `translations` ADD COLUMN `last_provider` text;
--> statement-breakpoint
ALTER TABLE `translations` ADD COLUMN `last_error_code` text;
--> statement-breakpoint

UPDATE `translations`
SET `last_error_code` = 'unknown'
WHERE `status` = 'failed' AND `last_error_code` IS NULL;
