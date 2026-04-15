import { NextRequest, NextResponse } from "next/server";
import { loadBookForRead } from "@/lib/access";
import { getUploadsStorage } from "@/lib/storage";

/**
 * Stream an inline image extracted from the book's EPUB. Authz reuses
 * loadBookForRead so visibility rules stay identical to the book page.
 * filename is sanitized against path traversal; the parser already ensures
 * storage keys use only [A-Za-z0-9._-], so anything outside that set in
 * the URL is a bad-faith request.
 */
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

function isSafeFilename(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false;
  if (name.includes("..")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("\0")) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> },
) {
  const { id, filename } = await params;
  if (!isSafeFilename(filename)) {
    return NextResponse.json({ error: "Bad filename" }, { status: 400 });
  }

  const { book } = await loadBookForRead(id);
  if (!book) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await getUploadsStorage().get(`${id}/images/${filename}`);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const extMatch = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  const mime =
    (extMatch && MIME_BY_EXT[extMatch[1]]) || "application/octet-stream";

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
