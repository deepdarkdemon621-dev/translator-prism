-- Learning module (L1): review event log, explicit per-lemma word status,
-- daily reading sessions, and FSRS scheduling fields on vocabulary.
-- Purely additive; new tables start empty and vocabulary columns are
-- nullable (NULL state = card not yet migrated from the Leitner stage).
ALTER TABLE `vocabulary` ADD COLUMN `stability` real;
--> statement-breakpoint
ALTER TABLE `vocabulary` ADD COLUMN `difficulty` real;
--> statement-breakpoint
ALTER TABLE `vocabulary` ADD COLUMN `state` text;
--> statement-breakpoint
ALTER TABLE `vocabulary` ADD COLUMN `lapses` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `vocabulary` ADD COLUMN `context_word_start` integer;
--> statement-breakpoint
ALTER TABLE `vocabulary` ADD COLUMN `context_word_end` integer;
--> statement-breakpoint
CREATE TABLE `review_logs` (
  `id` text PRIMARY KEY NOT NULL,
  `vocabulary_id` text NOT NULL REFERENCES `vocabulary`(`id`) ON DELETE CASCADE,
  `user_id` text,
  `rating` text NOT NULL,
  `state_before` text,
  `stage_before` integer,
  `stability_before` real,
  `difficulty_before` real,
  `elapsed_days` real,
  `scheduled_days` real,
  `reviewed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_review_logs_user_time` ON `review_logs` (`user_id`, `reviewed_at`);
--> statement-breakpoint
CREATE INDEX `idx_review_logs_vocab` ON `review_logs` (`vocabulary_id`, `reviewed_at`);
--> statement-breakpoint
CREATE TABLE `word_status` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `lang` text NOT NULL,
  `lemma` text NOT NULL,
  `status` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_word_status_user_lang_lemma` ON `word_status` (`user_id`, `lang`, `lemma`);
--> statement-breakpoint
CREATE TABLE `reading_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `book_id` text,
  `day` text NOT NULL,
  `chars_read` integer NOT NULL DEFAULT 0,
  `duration_ms` integer NOT NULL DEFAULT 0,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reading_sessions_user_day_book` ON `reading_sessions` (`user_id`, `day`, `book_id`);
