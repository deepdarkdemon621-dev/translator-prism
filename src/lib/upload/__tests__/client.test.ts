import { describe, expect, it, vi } from "vitest";
import { uploadEpubFile } from "../client";

function epubFile(size: number) {
  return new File([new Uint8Array(size)], "book.epub", {
    type: "application/epub+zip",
  });
}

describe("uploadEpubFile", () => {
  it("uses multipart upload for small EPUBs", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ id: "book-1", title: "Small Book" }),
    );

    const result = await uploadEpubFile({
      file: epubFile(1024),
      isAdmin: false,
      visibility: "public",
      targetCollectionId: "",
      fetchImpl,
    });

    expect(result).toEqual({ id: "book-1", title: "Small Book" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/books/upload",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      }),
    );
  });

  it("uses direct object-storage upload for large EPUBs", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          bookId: "book-2",
          key: "book-2.epub",
          uploadUrl: "https://r2.example/upload",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ id: "book-2", title: "Large Book" }));

    const file = epubFile(5 * 1024 * 1024);
    const result = await uploadEpubFile({
      file,
      isAdmin: true,
      visibility: "private",
      targetCollectionId: "collection-1",
      fetchImpl,
    });

    expect(result).toEqual({ id: "book-2", title: "Large Book" });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/books/upload/prepare",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          fileName: "book.epub",
          size: file.size,
          contentType: "application/epub+zip",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://r2.example/upload",
      expect.objectContaining({
        method: "PUT",
        body: file,
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "/api/books/upload/complete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          bookId: "book-2",
          key: "book-2.epub",
          fileName: "book.epub",
          visibility: "private",
          collectionId: "collection-1",
        }),
      }),
    );
  });
});
