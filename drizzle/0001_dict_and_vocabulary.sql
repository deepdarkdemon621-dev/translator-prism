CREATE TABLE `dictionaries` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`source_lang` text NOT NULL,
	`entry_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `dict_entries` USING fts5(
	`dictionary_id` UNINDEXED,
	`headword`,
	`reading`,
	`gloss`,
	tokenize = 'unicode61'
);
--> statement-breakpoint
CREATE TABLE `vocabulary` (
	`id` text PRIMARY KEY NOT NULL,
	`word` text NOT NULL,
	`lang` text NOT NULL,
	`reading` text,
	`gloss` text NOT NULL,
	`note` text,
	`source_book_id` text,
	`source_context` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_vocab_lang` ON `vocabulary` (`lang`);
--> statement-breakpoint
CREATE INDEX `idx_vocab_word_lang` ON `vocabulary` (`word`, `lang`);
