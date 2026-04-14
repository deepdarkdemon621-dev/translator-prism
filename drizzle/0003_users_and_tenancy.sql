-- Phase 1 multi-tenancy: introduce users and attribute existing data to a
-- seed admin. All pre-existing books default to visibility='public' so they
-- serve as the showcase collection new users see on signup. Clerk user IDs
-- (clerk_user_id) are nullable for now — this column will be populated by a
-- Clerk webhook in phase 3; until then auth is stubbed to the seed admin.

CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`clerk_user_id` text,
	`email` text,
	`display_name` text,
	`is_admin` integer DEFAULT 0 NOT NULL,
	`credits` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_clerk_user_id` ON `users` (`clerk_user_id`);
--> statement-breakpoint
-- Seed admin: fixed UUID so later code/migrations can reference it reliably.
-- Starts with a large credit pile because admin is exempt from billing anyway.
INSERT INTO `users` (`id`, `email`, `display_name`, `is_admin`, `credits`, `created_at`, `updated_at`)
VALUES (
	'00000000-0000-0000-0000-000000000001',
	'admin@local',
	'Admin',
	1,
	999999,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
--> statement-breakpoint
-- Add tenancy columns to books. `visibility` defaults to 'public' so we don't
-- accidentally hide existing data behind a paywall during rollout.
ALTER TABLE `books` ADD COLUMN `user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `visibility` text NOT NULL DEFAULT 'public';
--> statement-breakpoint
-- Backfill existing books to seed admin.
UPDATE `books` SET `user_id` = '00000000-0000-0000-0000-000000000001' WHERE `user_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_books_user_id` ON `books` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_books_visibility` ON `books` (`visibility`);
--> statement-breakpoint
-- Vocabulary: each user has their own deck.
ALTER TABLE `vocabulary` ADD COLUMN `user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
UPDATE `vocabulary` SET `user_id` = '00000000-0000-0000-0000-000000000001' WHERE `user_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_vocab_user_id` ON `vocabulary` (`user_id`);
--> statement-breakpoint
-- Reading progress: per-user per-book.
ALTER TABLE `reading_progress` ADD COLUMN `user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
UPDATE `reading_progress` SET `user_id` = '00000000-0000-0000-0000-000000000001' WHERE `user_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_progress_user_book` ON `reading_progress` (`user_id`, `book_id`);
--> statement-breakpoint
-- chapter_access: who has paid for which chapter. Absence of a row = not paid.
-- Public books + admin users bypass this table entirely.
CREATE TABLE `chapter_access` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`),
	`chapter_id` text NOT NULL REFERENCES `chapters`(`id`) ON DELETE CASCADE,
	`credits_spent` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chapter_access_user_chapter` ON `chapter_access` (`user_id`, `chapter_id`);
