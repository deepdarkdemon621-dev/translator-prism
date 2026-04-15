import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { loadBookForWrite } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { getUploadsStorage, getCoversStorage } from "@/lib/storage";
import { moveBookToCollection } from "@/lib/collections";

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
    return await doDelete(ids);
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
    return await doMove(ids, target);
  }

  return NextResponse.json({ error: "action must be 'delete' or 'move'" }, { status: 400 });
}

async function doDelete(ids: string[]) {
  const db = getDb();
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      const result = await loadBookForWrite(id);
      if (!result.book) {
        failed.push({ id, error: "not found" });
        continue;
      }
      if (result.forbidden) {
        failed.push({ id, error: "forbidden" });
        continue;
      }
      const { book } = result;
      await getUploadsStorage().delete(book.filePath);
      if (book.coverPath) {
        await getCoversStorage().delete(book.coverPath);
      }
      await db.delete(books).where(eq(books.id, id)).run();
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return NextResponse.json({ succeeded: succeeded.length, failed });
}

async function doMove(ids: string[], targetCollectionId: string | null) {
  const user = await getCurrentUser();
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      await moveBookToCollection({
        bookId: id,
        targetCollectionId,
        actingUserId: user.id,
        actingIsAdmin: user.isAdmin,
      });
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return NextResponse.json({ succeeded: succeeded.length, failed });
}
