ALTER TABLE `books` ADD `collection_id` text REFERENCES collections(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `collection_seq` integer;--> statement-breakpoint
ALTER TABLE `collections` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
UPDATE `collections` SET `visibility` = 'public' WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `is_admin` = 1);--> statement-breakpoint
DROP TABLE `collection_books`;
