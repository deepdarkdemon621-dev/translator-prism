# Library Multi-Select — Design

**Status:** Approved
**Date:** 2026-04-15

## Goal

Let users act on multiple books or collections at once in the library UI:
bulk move books into/out of collections, bulk delete books (inside and
outside a collection), and bulk delete collections (cascading to the books
inside). Desktop-only; checkbox-based selection.

## Non-goals

- Mobile / touch support. The select toggle and action bar are gated at
  the `sm:` breakpoint; touch viewports never see them.
- Multi-select in the Vocabulary page.
- Drag-and-drop selection (lasso / rubber-band). Selection is click-only.
- Shift-click range selection. Intentionally excluded — simpler model.
- Mixing books and collections in one selection. Each section has its
  own independent selection state.
- Admin-level bulk actions (Translate-all, Cancel-all, Import) — those
  remain as-is.

## Surfaces

Three grids gain multi-select, each with an independent `Select` toggle:

1. **Home · Collections grid** — bulk delete (cascades to books inside).
2. **Home · Library grid** (top-level books) — bulk delete, bulk move
   into a collection.
3. **Collection detail · books list** — bulk delete, bulk move out
   (back to top level), bulk move to another collection.

## UI behavior

**Entry:** each section header gets a small `Select` button next to its
existing controls (Collections grid next to `+ New collection`;
Library and collection-detail get a standalone button).

**In select mode:**
- Every card in that section shows a checkbox in its top-left corner.
- Clicking a card body toggles its checkbox instead of navigating.
  Cover art stays the visual click target.
- No shift-click, no drag-box. Plain click-to-toggle only.
- `Esc` exits select mode for that section.
- A floating action bar slides up from the bottom of the viewport
  (sticky, ~600px max width, centered, card-style matching the warm
  palette). It shows the selection count, `Select all` / `Clear`
  link, the action buttons, and a `Done` button.

**Scope:** selection state is local to the page. Selections don't
persist across reloads or route changes. The two home-page sections
have independent select modes — entering select mode on Library
doesn't touch Collections.

## Actions per surface

**Home · Library**, bar shows:
- `Move to collection ▾` — dropdown of the user's collections.
- `Delete` — confirm: "Delete N books? This can't be undone."

**Home · Collections**, bar shows:
- `Delete` — confirm: "Delete N collections and all M books inside
  them? This can't be undone." M is summed across selected collections
  from current data.

**Collection detail · books list**, bar shows:
- `Move out` — back to top level.
- `Move to collection ▾` — other user collections (current excluded).
- `Delete` — same confirm as Library.

Destructive actions close the bar and exit select mode on success.
On partial failure the bar stays open with the failed items still
selected.

## Backend

Two new bulk endpoints. Each loops atomically per-item so a partial
failure leaves partial progress rather than silent no-op.

### `POST /api/books/bulk`

Body: `{ action: "delete" | "move", ids: string[], collectionId?: string | null }`

- `delete` — loop the existing per-book delete for each id (owner-scoped;
  admin is not backdoored for other users' books, matching current
  single-item policy).
- `move` — loop `moveBookToCollection`. `collectionId: null` = move to
  top level; string = move into that collection.

Returns `{ succeeded: number, failed: Array<{ id: string; error: string }> }`.

### `POST /api/collections/bulk`

Body: `{ action: "delete", ids: string[] }`

For each collection id: verify ownership via `loadOwnedCollection`,
then inside a transaction delete every book whose `collection_id`
matches (cascading to chapters/paragraphs/translations as books already
do), then delete the collection row. This overrides the
`ON DELETE SET NULL` schema default so books are destroyed, not
orphaned to top level.

Returns `{ succeeded: number, failed: Array<{ id: string; error: string }> }`.

### Authz

Reuse existing helpers (`loadOwnedCollection`, book-owner check).
Admin's view-only backdoor for other users' collections does NOT
extend to bulk delete.

### Schema

No migrations. No new tables.

## File structure

**New:**
- `src/app/api/books/bulk/route.ts` — POST handler for book bulk ops.
- `src/app/api/collections/bulk/route.ts` — POST handler for cascade-delete.
- `src/components/library/SelectionBar.tsx` — floating action bar,
  shared by all three surfaces; accepts actions as props.
- `src/components/library/useSelection.ts` — hook exposing
  `{ mode, selected, toggle, selectAll, clear, enter, exit }` over
  an array of ids.

**Modified:**
- `src/app/page.tsx` — two `useSelection` instances (books,
  collections); `Select` toggles per section; pass selection state
  into `BookCard` / `CollectionCard`; render `SelectionBar` when a
  mode is active.
- `src/app/collections/[id]/page.tsx` — one `useSelection` for the
  books list; `Select` toggle in the header; `SelectionBar`.
- `src/components/BookCard.tsx` — accept `selectMode`, `selected`,
  `onSelectToggle`; overlay a checkbox and intercept the click to
  toggle (suppresses the link navigation) when in select mode.
- `src/components/CollectionCard.tsx` — same treatment.

## Error handling

- **Partial failure** — bar stays open, alert shows
  "3 of 5 succeeded. Failed: <titles>". Succeeded ids are removed
  from the selection; failed ids remain so the user can retry.
- **Empty selection** — action buttons disabled.
- **In-flight translations on a book being deleted** — single-item
  delete already cascades to translations/paragraphs; bulk inherits.
- **Deleted book open in a reader tab** — reader 404s on next fetch.
  Acceptable, matches single-delete today.
- **Select mode + nav** — clicks on nav links, UserButton, and other
  non-card elements still work. Only card clicks are captured.
- **Esc handler** — attached only while a section is in select mode,
  detached on exit, scoped to that section.

## Testing

Manual smoke coverage only, inside the Task 12 smoke test:

1. Home: enter Library select mode, select 2 books, Delete — both gone,
   collections section untouched.
2. Home: select 2 books, Move to collection X — both appear in X.
3. Home: enter Collections select mode, select 1 collection with 2
   books, Delete — collection and both books gone from DB.
4. Collection detail: select 2 books, Move out — both return to top
   level, collection's remaining book count drops.
5. Esc exits select mode; `Select all` selects everything in that
   section only.

No unit tests required — the hook is small and the backend loops over
existing, already-tested single-item operations.
