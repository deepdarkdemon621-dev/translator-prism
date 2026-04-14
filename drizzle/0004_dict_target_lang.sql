-- Dictionaries were previously assumed English-gloss (JMdict_e, CC-CEDICT).
-- To support JMdict's multi-lang edition (with <gloss xml:lang="zho"> etc.),
-- we track each dictionary's target language. Existing rows backfill to 'en'
-- since that's what we shipped. The column is NOT NULL after backfill so
-- lookup code can rely on it.
ALTER TABLE `dictionaries` ADD COLUMN `target_lang` text NOT NULL DEFAULT 'en';
--> statement-breakpoint
CREATE INDEX `idx_dicts_source_target` ON `dictionaries` (`source_lang`, `target_lang`);
