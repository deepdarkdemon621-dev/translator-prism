-- Learning module (L3/L4): dictionary-form lemma on vocabulary rows, and a
-- lemma index over paragraphs for corpus example search. paragraph_lemmas
-- stores space-joined kuromoji base forms per paragraph (written by app
-- code at import/backfill time — SQL triggers cannot tokenize Japanese);
-- the FTS mirror makes single-lemma lookups fast and matches conjugated
-- occurrences, including 1-2 character words trigram cannot handle.
ALTER TABLE `vocabulary` ADD COLUMN `lemma` text;
--> statement-breakpoint
CREATE TABLE `paragraph_lemmas` (
  `paragraph_id` text PRIMARY KEY NOT NULL REFERENCES `paragraphs`(`id`) ON DELETE CASCADE,
  `lemmas` text NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `paragraph_lemmas_fts` USING fts5(
  `lemmas`,
  content=`paragraph_lemmas`,
  content_rowid=`rowid`
);
--> statement-breakpoint
CREATE TRIGGER `paragraph_lemmas_ai` AFTER INSERT ON `paragraph_lemmas` BEGIN
  INSERT INTO `paragraph_lemmas_fts`(rowid, lemmas) VALUES (new.rowid, new.lemmas);
END;
--> statement-breakpoint
CREATE TRIGGER `paragraph_lemmas_ad` AFTER DELETE ON `paragraph_lemmas` BEGIN
  INSERT INTO `paragraph_lemmas_fts`(`paragraph_lemmas_fts`, rowid, lemmas) VALUES ('delete', old.rowid, old.lemmas);
END;
--> statement-breakpoint
CREATE TRIGGER `paragraph_lemmas_au` AFTER UPDATE ON `paragraph_lemmas` BEGIN
  INSERT INTO `paragraph_lemmas_fts`(`paragraph_lemmas_fts`, rowid, lemmas) VALUES ('delete', old.rowid, old.lemmas);
  INSERT INTO `paragraph_lemmas_fts`(rowid, lemmas) VALUES (new.rowid, new.lemmas);
END;
