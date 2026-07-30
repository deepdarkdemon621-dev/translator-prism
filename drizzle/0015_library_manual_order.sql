-- Manual ordering for the top-level library and the collections grid
-- (drag-and-drop sorting). Nullable and additive: NULL means "never
-- manually ordered" and sorts after ordered rows, falling back to the
-- previous date-based ordering. No backfill needed.
ALTER TABLE `books` ADD COLUMN `library_seq` integer;
--> statement-breakpoint
ALTER TABLE `collections` ADD COLUMN `seq` integer;
