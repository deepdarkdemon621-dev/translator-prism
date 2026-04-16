-- Row-read optimisation: the hot query paths on /progress, /api/books,
-- /api/chapters/[id]/status and the worker all join
-- books → chapters → paragraphs → translations on FK columns that
-- previously had no index. Without these, every aggregation was a
-- full-scan of translations (~500k+ rows), which burned through the
-- Turso monthly row-read quota fast. Each index below tracks one of
-- those join/filter predicates.
CREATE INDEX IF NOT EXISTS `idx_chapters_book_id` ON `chapters` (`book_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chapters_book_status` ON `chapters` (`book_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_paragraphs_chapter_id` ON `paragraphs` (`chapter_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_translations_paragraph_status` ON `translations` (`paragraph_id`, `status`);
--> statement-breakpoint
-- Used by /api/system-status and the progress throughput window, both
-- of which filter translations by status then order by updated_at.
CREATE INDEX IF NOT EXISTS `idx_translations_status_updated` ON `translations` (`status`, `updated_at`);
