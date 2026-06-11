-- Hot paths for collection cards/details and progress visibility filters.
-- Collection pages repeatedly filter by collection_id and order by
-- collection_seq/created_at for the cover and member order.
CREATE INDEX IF NOT EXISTS `idx_books_collection_seq`
ON `books` (`collection_id`, `collection_seq`, `created_at`);
--> statement-breakpoint
-- Progress and library visibility filters join or filter by owner and
-- public-admin visibility.
CREATE INDEX IF NOT EXISTS `idx_books_user_id`
ON `books` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_books_visibility_user`
ON `books` (`visibility`, `user_id`);
