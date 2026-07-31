-- Per-user review scheduling preference (default: classic Ebbinghaus
-- fixed-interval curve; FSRS stays available as the adaptive option) and
-- an algorithm tag on review logs so the dashboard can compare retention
-- per algorithm. All additive; NULLs mean "default".
ALTER TABLE `users` ADD COLUMN `review_algorithm` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `review_intervals` text;
--> statement-breakpoint
ALTER TABLE `review_logs` ADD COLUMN `algorithm` text;
