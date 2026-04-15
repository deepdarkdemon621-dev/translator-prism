import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, collections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { loadOwnedCollection } from "@/lib/collections";
import { getUploadsStorage, getCoversStorage } from "@/lib/storage";

interface BulkBody {
  action?: string;
  ids?: unknown;
}

/**
 * Bulk cascade-delete collections. For each id:
 *   1. Verify the caller owns it (loadOwnedCollection — admin backdoor
 *      stays view-only and does not apply to writes).
 *   2. Delete every book whose collection_id matches. Book deletes
 *      cascade to chapters/paragraphs/translations via FK.
 *   3. Delete the collection row.
 *
 * Per-id try/catch so one bad row doesn't abort the rest. Partial
 * failure is reported via `failed[]` in the response.
 *
 * Storage cleanup (EPUB bytes + covers) mirrors the single-book delete
 * route so orphaned files don't accumulate when dropping a whole series.
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
  if (body.action !== "delete") {
    return NextResponse.json({ error: "action must be 'delete'" }, { status: 400 });
  }

  const user = await getCurrentUser();
  const db = getDb();
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      const owned = await loadOwnedCollection(id, {
        id: user.id,
        isAdmin: user.isAdmin,
      });
      if (!owned) {
        failed.push({ id, error: "not found or not owned" });
        continue;
      }

      const booksInside = await db
        .select({
          id: books.id,
          filePath: books.filePath,
          coverPath: books.coverPath,
        })
        .from(books)
        .where(eq(books.collectionId, id))
        .all();

      for (const b of booksInside) {
        await getUploadsStorage().delete(b.filePath);
        if (b.coverPath) {
          await getCoversStorage().delete(b.coverPath);
        }
        await db.delete(books).where(eq(books.id, b.id)).run();
      }

      await db.delete(collections).where(eq(collections.id, id)).run();
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return NextResponse.json({ succeeded: succeeded.length, failed });
}
