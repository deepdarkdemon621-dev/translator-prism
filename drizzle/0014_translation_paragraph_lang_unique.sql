-- Gate D (ARCH-002): enforce one translation row per (paragraph_id, lang).
-- Only safe after the controlled dedupe reduced production duplicate groups
-- to zero (verified 2026-07-24: duplicateGroups=0). Insert paths were made
-- conflict-safe ahead of this index (enqueue NOT EXISTS guard, import
-- payload dedupe).
CREATE UNIQUE INDEX IF NOT EXISTS `idx_translations_paragraph_lang`
ON `translations` (`paragraph_id`, `lang`);
