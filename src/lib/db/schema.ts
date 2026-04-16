import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// Fixed UUID for the seed admin user. Referenced from the 0003 migration so
// the app has a known tenant to attribute pre-existing data to; once Clerk is
// wired up, the auth stub swaps from "always this id" to a real session lookup.
export const SEED_ADMIN_ID = "00000000-0000-0000-0000-000000000001";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  clerkUserId: text("clerk_user_id"),
  email: text("email"),
  displayName: text("display_name"),
  // SQLite has no boolean: 0/1 integer. Keep as integer so drizzle doesn't
  // coerce — callers treat truthy == admin.
  isAdmin: integer("is_admin").notNull().default(0),
  credits: integer("credits").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author").notNull().default("Unknown"),
  sourceLang: text("source_lang").notNull(), // ja | zh | en
  coverPath: text("cover_path"),
  filePath: text("file_path").notNull(),
  totalChapters: integer("total_chapters").notNull().default(0),
  status: text("status").notNull().default("pending"), // pending | parsed | error
  // Tenancy: nullable only for compatibility with historical rows before
  // migration 0003; new inserts should always set this.
  userId: text("user_id").references(() => users.id),
  // 'public' = showcase book visible to all; 'private' = only owner sees it.
  visibility: text("visibility").notNull().default("public"),
  // Folder-model: a book lives in at most one collection. NULL = top
  // level (shown in main library). When set, the book is hidden from
  // the main library and shown inside the collection view instead.
  // ON DELETE SET NULL in the migration — deleting a collection returns
  // its books to top level without cascading into the books table.
  collectionId: text("collection_id").references(() => collections.id, { onDelete: "set null" }),
  // Display order inside the collection. Lowest wins and also
  // determines the collection cover. NULL when collectionId is NULL.
  collectionSeq: integer("collection_seq"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const chapters = sqliteTable("chapters", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  index: integer("index").notNull(),
  title: text("title").notNull(),
  sourceHtml: text("source_html").notNull(),
  status: text("status").notNull().default("pending"), // pending | translating | done | error
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const paragraphs = sqliteTable("paragraphs", {
  id: text("id").primaryKey(),
  chapterId: text("chapter_id").notNull().references(() => chapters.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  sourceText: text("source_text").notNull(),
  sourceMarkup: text("source_markup").notNull(),
  // "text" for <p> rows, "image" for <img> rows. Translation pipeline
  // filters to kind = 'text'; reader + exporter render both in seq order.
  kind: text("kind", { enum: ["text", "image"] }).notNull().default("text"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const translations = sqliteTable("translations", {
  id: text("id").primaryKey(),
  paragraphId: text("paragraph_id").notNull().references(() => paragraphs.id, { onDelete: "cascade" }),
  lang: text("lang").notNull(), // zh | en | ja
  text: text("text").notNull().default(""),
  status: text("status").notNull().default("pending"), // pending | processing | done | failed
  model: text("model"),
  tokensUsed: integer("tokens_used"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const readingProgress = sqliteTable("reading_progress", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id),
  chapterIndex: integer("chapter_index").notNull().default(0),
  scrollPosition: real("scroll_position").notNull().default(0),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const dictionaries = sqliteTable("dictionaries", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  format: text("format").notNull(), // 'jmdict' | 'cedict'
  sourceLang: text("source_lang").notNull(), // 'ja' | 'zh'
  // Target language of the gloss text. JMdict_e / CC-CEDICT are both 'en';
  // the multi-language JMdict distribution additionally lets us install a
  // 'zh' / 'de' / ... variant of the same source_lang. Lookup ignores this
  // field but the UI groups by (source,target) so users pick the right one.
  targetLang: text("target_lang").notNull().default("en"),
  entryCount: integer("entry_count").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// Note: dict_entries is an FTS5 virtual table created via raw SQL migration.
// Drizzle's schema DSL does not support FTS5, so we interact with it via
// sqlite.prepare() directly in src/lib/dict/*.

export const vocabulary = sqliteTable("vocabulary", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id),
  word: text("word").notNull(),
  lang: text("lang").notNull(), // 'ja' | 'zh' | 'en'
  reading: text("reading"),
  gloss: text("gloss").notNull(),
  note: text("note"),
  sourceBookId: text("source_book_id"), // nullable, no cascade
  sourceContext: text("source_context"),
  // SRS fields — see src/lib/vocab/srs.ts. nextReviewAt is null for entries
  // that have never been reviewed; those are treated as "due now" so they
  // show up in the first review session.
  stage: integer("stage").notNull().default(0),
  nextReviewAt: text("next_review_at"),
  lastReviewedAt: text("last_reviewed_at"),
  correctCount: integer("correct_count").notNull().default(0),
  incorrectCount: integer("incorrect_count").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// Collections: a user's named bundle of books (a series, a mood shelf).
// The cover image shown for the collection is inherited from whichever
// member book has the smallest collection_seq — we don't store a cover
// on the collection itself, so reordering books automatically propagates.
export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  // Admin's collections default to 'public' (visible to all users,
  // symmetric to admin-public books). Regular users' collections are
  // always 'private'; the create endpoint enforces this.
  visibility: text("visibility").notNull().default("private"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// Single-row key/value store for app-wide settings (LLM provider config,
// reading defaults). Historically backed by data/settings.json; moved to
// the DB because Vercel's filesystem is read-only and the JSON writes
// were silently dropping the user's provider selection in production.
// 'key' is always 'global' for now; we may add per-user rows later.
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// Paywall: presence of a row means "user has paid to translate/read this
// chapter". Public books and admin users skip the check entirely — see
// src/lib/billing. credits_spent is auditing only; the spend is computed
// against users.credits at purchase time.
export const chapterAccess = sqliteTable("chapter_access", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  chapterId: text("chapter_id").notNull().references(() => chapters.id, { onDelete: "cascade" }),
  creditsSpent: integer("credits_spent").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});
