import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { parseEpub } from "../parser";

/** Build an in-memory EPUB zip with the given chapter HTMLs and image files.
 * Chapter files live at OEBPS/text/ch{N}.xhtml, images at OEBPS/images/. */
async function buildEpub(opts: {
  chapters: string[];
  imageFiles?: Record<string, Buffer>;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`,
  );

  const imageManifest = Object.keys(opts.imageFiles || {})
    .map(
      (path, i) =>
        `<item id="img${i}" href="${path}" media-type="image/jpeg"/>`,
    )
    .join("\n");

  const chapterManifest = opts.chapters
    .map(
      (_, i) =>
        `<item id="ch${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const spine = opts.chapters
    .map((_, i) => `<itemref idref="ch${i}"/>`)
    .join("\n");

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test</dc:title><dc:creator>Author</dc:creator><dc:language>en</dc:language>
    </metadata>
    <manifest>${chapterManifest}${imageManifest}</manifest>
    <spine>${spine}</spine></package>`,
  );

  for (let i = 0; i < opts.chapters.length; i++) {
    zip.file(
      `OEBPS/text/ch${i}.xhtml`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${opts.chapters[i]}</body></html>`,
    );
  }
  for (const [path, bytes] of Object.entries(opts.imageFiles || {})) {
    zip.file(`OEBPS/${path}`, bytes);
  }

  const u8 = await zip.generateAsync({ type: "uint8array" });
  return Buffer.from(u8);
}

describe("parseEpub image support", () => {
  it("emits text and image rows in document order", async () => {
    const buf = await buildEpub({
      chapters: [`<p>A</p><img src="../images/foo.jpg" alt="cover"/><p>B</p>`],
      imageFiles: { "images/foo.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
    });
    const parsed = await parseEpub(buf);
    const paras = parsed.chapters[0].paragraphs;
    expect(paras.map((p) => p.kind)).toEqual(["text", "image", "text"]);
    expect(paras[0].text).toBe("A");
    expect(paras[1].alt).toBe("cover");
    expect(paras[1].markup).toContain('src="images/foo.jpg"');
    expect(paras[2].text).toBe("B");
  });

  it("resolves ../ in img src and uses sanitized basename", async () => {
    const buf = await buildEpub({
      chapters: [`<img src="../images/foo.jpg" alt=""/>`],
      imageFiles: { "images/foo.jpg": Buffer.from([0x1]) },
    });
    const parsed = await parseEpub(buf);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].filename).toBe("foo.jpg");
  });

  it("assigns collision suffixes when two images sanitize to the same name", async () => {
    const buf = await buildEpub({
      chapters: [
        `<img src="../a/p 1.jpg" alt=""/><img src="../b/p 1.jpg" alt=""/>`,
      ],
      imageFiles: {
        "a/p 1.jpg": Buffer.from([0x1]),
        "b/p 1.jpg": Buffer.from([0x2]),
      },
    });
    const parsed = await parseEpub(buf);
    const names = parsed.images.map((i) => i.filename).sort();
    expect(names).toEqual(["p_1-2.jpg", "p_1.jpg"]);
  });

  it("stores alt trimmed; empty string when absent", async () => {
    const buf = await buildEpub({
      chapters: [`<img src="../images/a.jpg" alt="  hi  "/><img src="../images/b.jpg"/>`],
      imageFiles: {
        "images/a.jpg": Buffer.from([0x1]),
        "images/b.jpg": Buffer.from([0x2]),
      },
    });
    const parsed = await parseEpub(buf);
    const paras = parsed.chapters[0].paragraphs;
    expect(paras[0].alt).toBe("hi");
    expect(paras[1].alt).toBe("");
  });

  it("dedups images referenced from multiple chapters", async () => {
    const buf = await buildEpub({
      chapters: [
        `<img src="../images/shared.jpg" alt=""/>`,
        `<img src="../images/shared.jpg" alt=""/>`,
      ],
      imageFiles: { "images/shared.jpg": Buffer.from([0x1]) },
    });
    const parsed = await parseEpub(buf);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.chapters[0].paragraphs[0].markup).toContain(
      'src="images/shared.jpg"',
    );
    expect(parsed.chapters[1].paragraphs[0].markup).toContain(
      'src="images/shared.jpg"',
    );
  });
});
