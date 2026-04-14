-- Collections (series grouping): a user's way to bundle books into a
-- named series. The collection's visual cover is derived from its first
-- book (lowest seq) rather than stored separately, so renaming a book or
-- reordering the list automatically updates the shelf.
CREATE TABLE `collections` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `name` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_collections_user` ON `collections` (`user_id`);
--> statement-breakpoint
-- A book can belong to multiple collections (rare but cheap to allow:
-- "Light Novels I'm reading" ∩ "Takagi-san series"). Composite PK
-- prevents duplicate inserts. seq controls display order and "who is
-- the cover" — the row with the smallest seq owns the visual.
CREATE TABLE `collection_books` (
  `collection_id` text NOT NULL REFERENCES `collections`(`id`) ON DELETE CASCADE,
  `book_id` text NOT NULL REFERENCES `books`(`id`) ON DELETE CASCADE,
  `seq` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  PRIMARY KEY (`collection_id`, `book_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_collection_books_order` ON `collection_books` (`collection_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `idx_collection_books_book` ON `collection_books` (`book_id`);
