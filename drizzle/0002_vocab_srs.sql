-- Add SRS (spaced repetition) fields to vocabulary so it can double as a
-- memorization deck. Stage indexes an interval table (see src/lib/vocab/srs.ts);
-- new entries start at stage 0 and are due immediately.
ALTER TABLE `vocabulary` ADD COLUMN `stage` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `vocabulary` ADD COLUMN `next_review_at` text;
--> statement-breakpoint
ALTER TABLE `vocabulary` ADD COLUMN `last_reviewed_at` text;
--> statement-breakpoint
ALTER TABLE `vocabulary` ADD COLUMN `correct_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `vocabulary` ADD COLUMN `incorrect_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX `idx_vocab_next_review` ON `vocabulary` (`next_review_at`);
