import { NextRequest, NextResponse } from "next/server";
import { exportJson, exportHtmlZip } from "@/lib/export/exporter";
import { loadBookForRead } from "@/lib/access";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const body = await request.json();
  const format = body.format || "json";

  // Gate export on visibility: anyone who can read the book can export its
  // translations. If we later want to restrict exports to owners only,
  // swap this for loadBookForWrite.
  const { book } = await loadBookForRead(bookId);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  try {
    const fileName = format === "html" ? await exportHtmlZip(bookId) : await exportJson(bookId);
    return NextResponse.json({ fileName, format });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
