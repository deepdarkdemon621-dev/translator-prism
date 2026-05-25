import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createUploadsPresignedPutUrl } from "@/lib/storage";
import { validateEpubUploadInput } from "@/lib/upload/server";

export async function POST(request: NextRequest) {
  try {
    await getCurrentUser();
    const body = await request.json() as {
      fileName?: unknown;
      size?: unknown;
      contentType?: unknown;
    };
    const fileName = typeof body.fileName === "string" ? body.fileName : "";
    const size = typeof body.size === "number" ? body.size : 0;
    const validationError = validateEpubUploadInput(fileName, size);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const bookId = randomUUID();
    const key = `${bookId}.epub`;
    const uploadUrl = await createUploadsPresignedPutUrl(
      key,
      typeof body.contentType === "string" && body.contentType
        ? body.contentType
        : "application/epub+zip",
    );

    return NextResponse.json({ bookId, key, uploadUrl });
  } catch (err) {
    console.error("Upload prepare error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload prepare failed" },
      { status: (err as { status?: number }).status ?? 500 },
    );
  }
}
