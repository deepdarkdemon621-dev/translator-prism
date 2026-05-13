-- Worker hot path: claim the oldest pending translation.
-- Covers WHERE status='pending' ORDER BY created_at LIMIT 1 so SQLite/libSQL
-- does not build a temp sort tree for every claimed row.
CREATE INDEX IF NOT EXISTS `idx_translations_status_created_id`
ON `translations` (`status`, `created_at`, `id`);
