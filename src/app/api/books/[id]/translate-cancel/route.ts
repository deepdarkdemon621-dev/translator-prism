import { NextResponse } from "next/server";
import { loadBookForWrite } from "@/lib/access";
import { cancelBookTranslations } from "@/lib/translate/cancel";

/**
 * Cancel every pending/processing translation in one book. Already-done
 * rows are kept. In-flight provider calls complete server-side but their
 * results are dropped by the queue's WHERE-guard. No cost gate — this
 * action only saves money, never spends it.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await loadBookForWrite(id);
  if (!result.book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }
  if (result.forbidden) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const { cancelled, chaptersReset } = cancelBookTranslations(id);
  return NextResponse.json({ cancelled, chaptersReset });
}
