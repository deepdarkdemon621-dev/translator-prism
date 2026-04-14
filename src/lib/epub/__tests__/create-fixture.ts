import JSZip from "jszip";
import fs from "fs";
import path from "path";

async function createTestEpub() {
  const zip = new JSZip();

  zip.file("mimetype", "application/epub+zip");

  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>テスト小説</dc:title>
    <dc:creator>テスト著者</dc:creator>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="toc">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`);

  zip.file("OEBPS/toc.ncx", `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>第一章 洞窟</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
    <navPoint id="np2" playOrder="2">
      <navLabel><text>第二章 スキル</text></navLabel>
      <content src="chapter2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`);

  zip.file("OEBPS/chapter1.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章</title></head>
<body>
  <h1>第一章 洞窟</h1>
  <p>目が覚めると、暗い洞窟の中にいた。</p>
  <p>何も見えない。何も<strong>聞こえない</strong>。</p>
  <p>ただ、意識だけがはっきりとしていた。</p>
</body>
</html>`);

  zip.file("OEBPS/chapter2.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第二章</title></head>
<body>
  <h1>第二章 スキル</h1>
  <p>スキルを獲得した。これは便利だ。</p>
  <p>新しい力を手に入れた気分だ。</p>
</body>
</html>`);

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const outDir = path.join(__dirname, "fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "test.epub"), buf);
  console.log("Test EPUB created.");
}

createTestEpub();
