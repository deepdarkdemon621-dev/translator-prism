import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getUploadsStorage } from "@/lib/storage";
import { createBookFromEpub } from "@/lib/upload/server";

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    const body = await request.json() as {
      bookId?: unknown;
      key?: unknown;
      fileName?: unknown;
      visibility?: unknown;
      collectionId?: unknown;
    };

    if (
      typeof body.bookId !== "string" ||
      typeof body.key !== "string" ||
      body.key !== `${body.bookId}.epub` ||
      typeof body.fileName !== "string"
    ) {
      return NextResponse.json({ error: "Invalid upload completion payload" }, { status: 400 });
    }

    const buffer = await getUploadsStorage().get(body.key);
    const result = await createBookFromEpub({
      buffer,
      fileName: body.fileName,
      rawVisibility: typeof body.visibility === "string" ? body.visibility : null,
      rawCollectionId: typeof body.collectionId === "string" ? body.collectionId : null,
      user,
      bookId: body.bookId,
      existingFileKey: body.key,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("Upload complete error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload completion failed" },
      { status: (err as { status?: number }).status ?? 500 },
    );
  }
}
