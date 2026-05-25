import { NextRequest, NextResponse } from "next/server";
import { createBookFromEpub, validateEpubUploadInput } from "@/lib/upload/server";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const validationError = validateEpubUploadInput(file.name, file.size);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  try {
    const result = await createBookFromEpub({
      buffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      rawVisibility: formData.get("visibility") as string | null,
      rawCollectionId: formData.get("collectionId") as string | null,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("Upload error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to parse EPUB" },
      { status: (err as { status?: number }).status ?? 500 },
    );
  }
}
