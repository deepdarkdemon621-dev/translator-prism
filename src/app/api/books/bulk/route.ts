import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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
    return await doMove(ids, target, user.id, user.isAdmin);
  }

  return NextResponse.json({ error: "action must be 'delete' or 'move'" }, { status: 400 });
}

async function doDelete(ids: string[], userId: string, isAdmin: boolean) {
  const db = getDb();
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      const book = await db.select().from(books).where(eq(books.id, id)).get();
      if (!book) {
        failed.push({ id, error: "not found" });
        continue;
      }
      if (!isAdmin && book.userId !== userId) {
        failed.push({ id, error: "forbidden" });
        continue;
      }
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

async function doMove(
  ids: string[],
  targetCollectionId: string | null,
  userId: string,
  isAdmin: boolean,
) {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      await moveBookToCollection({
        bookId: id,
        targetCollectionId,
        actingUserId: userId,
        actingIsAdmin: isAdmin,
      });
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return NextResponse.json({ succeeded: succeeded.length, failed });
}
