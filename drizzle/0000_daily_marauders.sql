CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`author` text DEFAULT 'Unknown' NOT NULL,
	`source_lang` text NOT NULL,
	`cover_path` text,
	`file_path` text NOT NULL,
	`total_chapters` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`index` integer NOT NULL,
	`title` text NOT NULL,
	`source_html` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `paragraphs` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
	`seq` integer NOT NULL,
	`source_text` text NOT NULL,
	`source_markup` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reading_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`chapter_index` integer DEFAULT 0 NOT NULL,
	`scroll_position` real DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `translations` (
	`id` text PRIMARY KEY NOT NULL,
	`paragraph_id` text NOT NULL,
	`lang` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`model` text,
	`tokens_used` integer,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`paragraph_id`) REFERENCES `paragraphs`(`id`) ON UPDATE no action ON DELETE cascade
);
