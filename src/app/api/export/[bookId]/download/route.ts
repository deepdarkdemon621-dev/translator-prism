import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { loadBookForRead } from "@/lib/access";
import { getExportsStorage } from "@/lib/storage";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;

  // Must be able to see the book to download its export file.
  const { book } = await loadBookForRead(bookId);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const fileName = url.searchParams.get("file");

  if (!fileName) {
    return NextResponse.json({ error: "Missing file parameter" }, { status: 400 });
  }

  // Validate the key before handing it to storage. path.basename strips
  // any traversal attempt, and we require the file to belong to this
  // book's namespace so one user can't yank another book's export by
  // guessing the id.
  const safeName = path.basename(fileName);
  if (
    safeName !== fileName ||
    !safeName.startsWith(`${bookId}.`) ||
    !(safeName.endsWith(".json") || safeName.endsWith(".zip"))
  ) {
    return NextResponse.json({ error: "Invalid file" }, { status: 400 });
  }

  try {
    const data = await getExportsStorage().get(safeName);
    const contentType = safeName.endsWith(".zip") ? "application/zip" : "application/json";
    // Next 16 types BodyInit strictly (no Buffer / Uint8Array<ArrayBufferLike>),
    // so hand it a fresh ArrayBuffer slice — the actual fetch runtime
    // accepts either, this is a pure type-side coercion.
    const ab = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    return new NextResponse(ab, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${safeName}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
