# Folder-model Collections

**Status:** Design approved 2026-04-15, awaiting implementation plan.

## Goal

Turn collections from an overlay grouping (a book can be in N collections and always visible in the main library) into a folder model: a book lives in **at most one** collection; once placed, it no longer appears in the main library.

## Decisions (locked)

- Folder model, flat — no nested collections.
- Scope v1: move single book in/out of collection; pick destination at upload time.
- Multi-select + drag-drop are deferred (C/D in brainstorm).
- Database has no user data yet — migration can drop the old join table without copying rows.

## Schema

### `books`
Add two nullable columns:
- `collection_id TEXT` — FK → `collections(id)` `ON DELETE SET NULL`
- `collection_seq INTEGER` — display order inside the collection; null when top-level

### `collections`
Add:
- `visibility TEXT NOT NULL DEFAULT 'private'` — `'public' | 'private'`

Existing admin-owned collections are updated to `public` so admin shelves stay visible to regular users (symmetric to book visibility).

### Drop
- `collection_books` table — replaced by `books.collection_id` + `collection_seq`.

### Migration 0006
```sql
ALTER TABLE books ADD COLUMN collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL;
ALTER TABLE books ADD COLUMN collection_seq INTEGER;
ALTER TABLE collections ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
UPDATE collections SET visibility = 'public'
  WHERE user_id IN (SELECT id FROM users WHERE is_admin = 1);
DROP TABLE collection_books;
```

No data-copy step — the database is empty of books/collection membership at migration time.

## API

### New
- `POST /api/books/[id]/move`
  - Body: `{ collectionId: string | null }`
  - Auth: book must be owned by caller. `collectionId` must be null or reference a collection owned by caller.
  - Effect: atomic update of `collection_id` and `collection_seq`. When moving into a collection, `collection_seq = (max existing seq in target) + 1`. When moving to top level, `collection_seq = NULL`.

### Changed
- `GET /api/books` — accepts `?scope=top`. When set, adds `AND collection_id IS NULL` to the existing visibility filter. Home page uses `?scope=top`; other callers unchanged.
- `POST /api/books/upload` — accepts optional `collectionId` form field. If it resolves to a collection owned by the current user, the new book is created with that `collection_id` and `collection_seq = max + 1`. Otherwise it is silently ignored and the book lands top-level (never fails the upload).
- `GET /api/collections` — admin sees all collections across users (backdoor). Regular users see own + admin `visibility='public'`.
- `GET /api/collections/[id]` — admin can load any collection. Owner sees all their books inside. Regular user viewing someone else's public collection sees only `visibility='public'` books inside.
- `POST /api/collections` — when creating, admin may pass `visibility`; regular users are forced to `private`. Remove the legacy `bookIds[]` bulk-append path (unused after folder model because adding happens book-side via `move`).
- `PUT /api/collections/[id]/books` — reorder endpoint stays, but operates on `books.collection_seq` instead of `collection_books.seq`. Ownership check unchanged (only collection owner can reorder).

### Removed
- `POST /api/collections/[id]/books` — replaced by `POST /api/books/[id]/move`
- `DELETE /api/collections/[id]/books/[bookId]` — replaced by `POST /api/books/[id]/move` with `collectionId: null`

### Permissions summary
| Action | Admin | Regular user |
|---|---|---|
| List collections | All users' | Own + admin public |
| View collection | Any | Own, or admin public (filtered to public books inside) |
| Create collection | Own; can set visibility | Own; forced private |
| Rename/delete collection | Own only | Own only |
| Move book | Own book → own collection (or top) | Own book → own collection (or top) |
| Reorder within collection | Own only | Own only |
| Upload with `collectionId` | Must be own collection | Must be own collection |

Admin backdoor is strictly view-only to prevent fat-finger edits on other users' data.

## UI

### Home page (`src/app/page.tsx`)
- Library section fetches `/api/books?scope=top` (not all).
- Collections section: unchanged rendering, list now may include admin-public collections for regular users.
- Admin badge: on BookCard and CollectionCard, when the item's `userId !== currentUser.id`, render a small owner badge in the corner (email or short label) — admin-only UI element.

### `BookCard`
- Add "⋯" menu (dropdown) consolidating:
  - Translate / Cancel (existing)
  - Delete (existing)
  - **Move to…** (new) — submenu or follow-up picker listing: `Top level` (when currently inside a collection) + caller's own collections. Selecting calls `POST /api/books/[id]/move`.
- Disabled for books the current user doesn't own (regular user viewing admin public book — no menu at all, same as current).

### `UploadZone`
- Add a "Collection" `<select>` above or beside the file picker.
- Options: `Top level` (default) + caller's own collections.
- On submit, append `collectionId` to the existing FormData.

### Collection page (`src/app/collections/[id]/page.tsx`)
- Remove "+ Add book" button + Add-book dialog (`addOpen` state, `handleAdd`, library fetch used by picker).
- "Remove" button → **"Move out"**, calls `POST /api/books/[id]/move` with `collectionId: null`.
- Reorder controls unchanged.
- When admin views another user's collection: read-only mode — hide Rename/Delete/Move out/reorder buttons (backdoor is view-only).

### `CollectionCard` + `BookCard` owner badge
- Tiny pill in the top-right when `item.userId !== currentUser.id`. Visible only when `currentUser.isAdmin` (regular users don't see others' items to need the badge).

## Edge cases
- Move into a collection the caller doesn't own → 403.
- Move a book the caller doesn't own → 403.
- Delete a collection with books inside → books revert to top-level via `ON DELETE SET NULL`; no confirm-cascading-delete dialog needed since books survive.
- Upload with malformed or alien `collectionId` → silently drop to top level; never error the upload.
- Regular user views an admin-public collection where every book is private → empty collection page; same template, just the books list is empty.

## Out of scope (explicit)
- Multi-select / bulk move (C)
- Drag-and-drop (D)
- Nested collections (F)
- Cross-tenant write operations for admin

## Files touched (expected)
- `src/lib/db/schema.ts` — add `collectionId`/`collectionSeq` to books, `visibility` to collections, remove `collectionBooks` export
- `drizzle/0006_folder_collections.sql` — migration
- `src/lib/collections.ts` — drop `appendBookToCollection`, `canUseBookInCollection`; add move helper with ownership checks
- `src/app/api/books/[id]/move/route.ts` — new
- `src/app/api/books/route.ts` — add `?scope=top` branch
- `src/app/api/books/upload/route.ts` — accept `collectionId`
- `src/app/api/collections/route.ts` — admin all-visibility branch; add `visibility` handling; drop `bookIds[]` bulk path
- `src/app/api/collections/[id]/route.ts` — admin read access; permission refactor
- `src/app/api/collections/[id]/books/route.ts` — reorder operates on `books.collection_seq`; DELETE file and POST removed
- `src/app/api/collections/[id]/books/[bookId]/route.ts` — delete file
- `src/app/page.tsx` — `?scope=top`, owner badge, remove library-side logic around collections-as-filters (none at present)
- `src/app/collections/[id]/page.tsx` — remove Add dialog, rename Remove → Move out, admin read-only branch
- `src/components/BookCard.tsx` — add "⋯" menu with Move to
- `src/components/CollectionCard.tsx` — owner badge
- `src/components/UploadZone.tsx` — collection select
