import { NextRequest, NextResponse } from "next/server";
import { loadBookForRead } from "@/lib/access";
import { BUNDLE_TIERS, quoteBundle, type BundleKey } from "@/lib/billing";

/**
 * Returns quotes for every bundle tier on a book. Used by the upload
 * confirmation screen and the reader's "unlock more chapters" panel so
 * the UI can show "X credits / Y already owned / Z new" per tier
 * without re-implementing the pricing math on the client.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { user, book } = await loadBookForRead(id);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const tiers = await Promise.all(
    (Object.keys(BUNDLE_TIERS) as BundleKey[]).map(async (key) => {
      const tier = BUNDLE_TIERS[key];
      const q = await quoteBundle(user, id, key);
      return {
        bundle: key,
        chapterLimit: tier.chapters,
        discountPct: tier.discountPct,
        ...q,
      };
    }),
  );

  return NextResponse.json({
    bookId: id,
    visibility: book.visibility,
    userCredits: user.credits,
    tiers,
  });
}
