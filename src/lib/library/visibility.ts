import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import type { getDb } from "@/lib/db";
import { books, collections, users } from "@/lib/db/schema";

type LibraryDb = ReturnType<typeof getDb>;

export interface LibraryActor {
  id: string;
  isAdmin: boolean;
}

async function getAdminUserIds(db: LibraryDb): Promise<string[]> {
  return (
    await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, 1))
      .all()
  ).map((user) => user.id);
}

export async function visibleBooksWhereForActor(
  db: LibraryDb,
  actor: LibraryActor,
): Promise<SQL | undefined> {
  if (actor.isAdmin) return undefined;

  const adminIds = await getAdminUserIds(db);
  const adminPublic = adminIds.length
    ? and(eq(books.visibility, "public"), inArray(books.userId, adminIds))
    : undefined;

  return adminPublic
    ? or(eq(books.userId, actor.id), adminPublic)
    : eq(books.userId, actor.id);
}

export async function visibleCollectionsWhereForActor(
  db: LibraryDb,
  actor: LibraryActor,
): Promise<SQL | undefined> {
  if (actor.isAdmin) return undefined;

  const adminIds = await getAdminUserIds(db);
  const adminPublic = adminIds.length
    ? and(
        eq(collections.visibility, "public"),
        inArray(collections.userId, adminIds),
      )
    : undefined;

  return adminPublic
    ? or(eq(collections.userId, actor.id), adminPublic)
    : eq(collections.userId, actor.id);
}

export function collectionMemberBooksWhere(
  collectionId: string,
  options: { includePrivateMembers: boolean },
): SQL {
  const base = eq(books.collectionId, collectionId);
  return options.includePrivateMembers
    ? base
    : and(base, eq(books.visibility, "public"))!;
}

export function collectionMemberBooksWhereForIds(
  collectionIds: string[],
  options: { includePrivateMembers: boolean },
): SQL {
  const base = inArray(books.collectionId, collectionIds);
  return options.includePrivateMembers
    ? base
    : and(base, eq(books.visibility, "public"))!;
}
