import { describe, expect, it, vi } from "vitest";
import { uploadEpubFilesSequentially } from "../batch-client";

function epubFile(name: string) {
  return new File([new Uint8Array(1024)], name, {
    type: "application/epub+zip",
  });
}

describe("uploadEpubFilesSequentially", () => {
  it("uploads files in order and reports each success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "book-1", title: "First" }))
      .mockResolvedValueOnce(Response.json({ id: "book-2", title: "Second" }));
    const starts = vi.fn();
    const successes = vi.fn();

    const result = await uploadEpubFilesSequentially({
      files: [epubFile("first.epub"), epubFile("second.epub")],
      isAdmin: false,
      visibility: "public",
      targetCollectionId: "",
      fetchImpl,
      onFileStart: starts,
      onFileSuccess: successes,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(starts).toHaveBeenNthCalledWith(1, "first.epub", 1, 2);
    expect(starts).toHaveBeenNthCalledWith(2, "second.epub", 2, 2);
    expect(successes).toHaveBeenNthCalledWith(
      1,
      { id: "book-1", title: "First" },
      "first.epub",
      1,
      2,
    );
    expect(successes).toHaveBeenNthCalledWith(
      2,
      { id: "book-2", title: "Second" },
      "second.epub",
      2,
      2,
    );
    expect(result).toEqual({
      successes: [
        { fileName: "first.epub", book: { id: "book-1", title: "First" } },
        { fileName: "second.epub", book: { id: "book-2", title: "Second" } },
      ],
      failures: [],
    });
  });

  it("continues after one file fails and records the failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "book-1", title: "First" }))
      .mockResolvedValueOnce(
        Response.json({ error: "Failed to parse EPUB" }, { status: 500 }),
      )
      .mockResolvedValueOnce(Response.json({ id: "book-3", title: "Third" }));
    const failures = vi.fn();

    const result = await uploadEpubFilesSequentially({
      files: [
        epubFile("first.epub"),
        epubFile("broken.epub"),
        epubFile("third.epub"),
      ],
      isAdmin: true,
      visibility: "private",
      targetCollectionId: "collection-1",
      fetchImpl,
      onFileError: failures,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(failures).toHaveBeenCalledWith(
      "Failed to parse EPUB",
      "broken.epub",
      2,
      3,
    );
    expect(result.successes.map((success) => success.fileName)).toEqual([
      "first.epub",
      "third.epub",
    ]);
    expect(result.failures).toEqual([
      { fileName: "broken.epub", error: "Failed to parse EPUB" },
    ]);
  });
});
