import { NextRequest, NextResponse } from "next/server";
import { loadBookForRead } from "@/lib/access";
import { getCoversStorage } from "@/lib/storage";

/**
 * Stream a book's cover image. Auth gates on loadBookForRead so private
 * books don't leak — non-owner non-admin callers get 404, same as if
 * the book didn't exist. Content-Type is inferred from the file
 * extension (persisted at upload time) so we don't have to sniff bytes.
 */
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { book } = await loadBookForRead(id);
  if (!book || !book.coverPath) {
    return NextResponse.json({ error: "No cover" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await getCoversStorage().get(book.coverPath);
  } catch {
    return NextResponse.json({ error: "No cover" }, { status: 404 });
  }

  const extMatch = book.coverPath.toLowerCase().match(/\.([a-z0-9]+)$/);
  const mime =
    (extMatch && MIME_BY_EXT[extMatch[1]]) || "application/octet-stream";

  // Covers are content-addressed by bookId + extension (never mutated),
  // so a long immutable cache is safe. Clients invalidate by swapping
  // the bookId — there's no in-place cover replace path today.
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
