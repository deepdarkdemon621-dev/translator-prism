import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { getUploadsStorage, getCoversStorage } from "@/lib/storage";
import { moveBooksToCollectionBulk } from "@/lib/collections";

// Keep IN params well inside SQLite's 999-variable limit.
const BULK_CHUNK = 200;

interface BulkBody {
  action?: string;
  ids?: unknown;
  collectionId?: string | null;
}

/**
 * Bulk operate on books. Two actions:
 *
 *   - "delete": destroy each id (cascades to chapters/paragraphs/translations)
 *   - "move":   move each id into `collectionId` (string) or to top level (null)
 *
 * Each id is processed independently — a mid-loop failure doesn't abort
 * the rest. The response `{ succeeded, failed }` lets the client report
 * partial progress and keep failed ids selected for retry.
 *
 * Authz reuses the same helpers the single-item routes use. Admin does
 * NOT gain write access to other users' books, matching single-delete.
 */
export async function POST(request: NextRequest) {
  let body: BulkBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string")
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty string array" }, { status: 400 });
  }

  if (body.action === "delete") {
    const user = await getCurrentUser();
    return await doDelete(ids, user.id, user.isAdmin);
  }
  if (body.action === "move") {
    const target =
      body.collectionId === null
        ? null
        : typeof body.collectionId === "string"
          ? body.collectionId
          : undefined;
    if (target === undefined) {
      return NextResponse.json(
        { error: "collectionId must be string or null for action=move" },
        { status: 400 },
      );
    }
    const user = await getCurrentUser();
    return await doMove(ids, target, user.id);
  }

  return NextResponse.json({ error: "action must be 'delete' or 'move'" }, { status: 400 });
}

async function doDelete(ids: string[], userId: string, isAdmin: boolean) {
  const db = getDb();
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  // One read for the whole batch instead of one per book. Storage deletes
  // stay per-book (file operations), but the DB rows go in one statement
  // per chunk — the per-book loop was 2 Turso round-trips per book.
  const found = new Map<string, { userId: string | null; filePath: string; coverPath: string | null }>();
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const rows = await db
      .select({
        id: books.id,
        userId: books.userId,
        filePath: books.filePath,
        coverPath: books.coverPath,
      })
      .from(books)
      .where(inArray(books.id, ids.slice(i, i + BULK_CHUNK)))
      .all();
    for (const row of rows) found.set(row.id, row);
  }

  const deletable: string[] = [];
  for (const id of ids) {
    const book = found.get(id);
    if (!book) {
      failed.push({ id, error: "not found" });
      continue;
    }
    if (!isAdmin && book.userId !== userId) {
      failed.push({ id, error: "forbidden" });
      continue;
    }
    try {
      await getUploadsStorage().delete(book.filePath);
      if (book.coverPath) {
        await getCoversStorage().delete(book.coverPath);
      }
      deletable.push(id);
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  for (let i = 0; i < deletable.length; i += BULK_CHUNK) {
    await db.delete(books).where(inArray(books.id, deletable.slice(i, i + BULK_CHUNK))).run();
  }
  succeeded.push(...deletable);

  return NextResponse.json({ succeeded: succeeded.length, failed });
}

// Note: like the single-book move, admin gets no write access to other
// users' books — ownership is enforced per book inside the bulk helper.
async function doMove(
  ids: string[],
  targetCollectionId: string | null,
  userId: string,
) {
  // Fixed query count regardless of batch size; the per-book loop was 5
  // Turso round-trips per book. Same permission + append-to-tail rules.
  const { succeeded, failed } = await moveBooksToCollectionBulk({
    bookIds: ids,
    targetCollectionId,
    actingUserId: userId,
  });

  return NextResponse.json({ succeeded: succeeded.length, failed });
}
