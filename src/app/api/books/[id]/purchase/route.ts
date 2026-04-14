import { NextRequest, NextResponse } from "next/server";
import { loadBookForWrite } from "@/lib/access";
import {
  BUNDLE_TIERS,
  InsufficientCreditsError,
  purchaseChapters,
  quoteBundle,
  type BundleKey,
} from "@/lib/billing";

/**
 * Purchase a chapter bundle for a private book. Public/showcase books
 * don't need this (they're free); non-owners can't even see private
 * books so loadBookForWrite will 404 them. Admins go through the same
 * path — purchaseChapters zeroes out the charge for them so the access
 * rows still get written and the rest of the code stays uniform.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const access = await loadBookForWrite(id);
  if (!access.book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }
  if (access.forbidden) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const { user, book } = access;

  if (book.visibility === "public" && !user.isAdmin) {
    return NextResponse.json(
      { error: "Public books are free" },
      { status: 400 },
    );
  }

  let body: { bundle?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const bundle = body.bundle as BundleKey | undefined;
  if (!bundle || !(bundle in BUNDLE_TIERS)) {
    return NextResponse.json(
      { error: `\`bundle\` must be one of: ${Object.keys(BUNDLE_TIERS).join(", ")}` },
      { status: 400 },
    );
  }

  const quote = quoteBundle(user, id, bundle);
  if (quote.chapterIds.length === 0) {
    return NextResponse.json({ error: "Book has no chapters" }, { status: 400 });
  }

  try {
    const result = purchaseChapters(user, quote.chapterIds, {
      discountPct: BUNDLE_TIERS[bundle].discountPct,
    });
    return NextResponse.json({ bundle, ...result });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return NextResponse.json(
        {
          error: err.message,
          code: "insufficient_credits",
          required: err.required,
          available: err.available,
        },
        { status: 402 },
      );
    }
    throw err;
  }
}
