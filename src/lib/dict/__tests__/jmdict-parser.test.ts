import { describe, it, expect } from "vitest";
import { parseJMdict, parseJMdictEntry } from "../jmdict-parser";

describe("JMdict parser", () => {
  it("parses an entry with one kanji form", () => {
    const entry = `
      <ent_seq>1578850</ent_seq>
      <k_ele><keb>行く</keb></k_ele>
      <r_ele><reb>いく</reb></r_ele>
      <sense>
        <pos>&v5k-s;</pos>
        <gloss>to go</gloss>
        <gloss>to move</gloss>
      </sense>
    `;
    const results = parseJMdictEntry(entry);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      headword: "行く",
      reading: "いく",
      gloss: "to go; to move",
    });
  });

  it("emits one entry per kanji variant", () => {
    const entry = `
      <k_ele><keb>行く</keb></k_ele>
      <k_ele><keb>往く</keb></k_ele>
      <r_ele><reb>いく</reb></r_ele>
      <sense><gloss>to go</gloss></sense>
    `;
    const results = parseJMdictEntry(entry);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.headword)).toEqual(["行く", "往く"]);
    expect(results[0].reading).toBe("いく");
    expect(results[1].reading).toBe("いく");
  });

  it("falls back to reading when there is no kanji form", () => {
    const entry = `
      <r_ele><reb>こんにちは</reb></r_ele>
      <sense><gloss>hello</gloss><gloss>good day</gloss></sense>
    `;
    const results = parseJMdictEntry(entry);
    expect(results).toHaveLength(1);
    expect(results[0].headword).toBe("こんにちは");
    expect(results[0].gloss).toBe("hello; good day");
  });

  it("decodes XML entities in glosses", () => {
    const entry = `
      <k_ele><keb>例</keb></k_ele>
      <r_ele><reb>れい</reb></r_ele>
      <sense><gloss>example (like &amp; such)</gloss></sense>
    `;
    const results = parseJMdictEntry(entry);
    expect(results[0].gloss).toBe("example (like & such)");
  });

  it("skips entries with no glosses", () => {
    const entry = `
      <k_ele><keb>空</keb></k_ele>
      <r_ele><reb>そら</reb></r_ele>
      <sense><pos>&n;</pos></sense>
    `;
    expect(parseJMdictEntry(entry)).toHaveLength(0);
  });

  it("filters glosses by xml:lang when targetLang is non-English", () => {
    const entry = `
      <k_ele><keb>本</keb></k_ele>
      <r_ele><reb>ほん</reb></r_ele>
      <sense>
        <gloss>book</gloss>
        <gloss xml:lang="zho">书</gloss>
        <gloss xml:lang="ger">Buch</gloss>
      </sense>
    `;
    const en = parseJMdictEntry(entry, "en");
    const zh = parseJMdictEntry(entry, "zh");
    const de = parseJMdictEntry(entry, "de");
    expect(en[0].gloss).toBe("book");
    expect(zh[0].gloss).toBe("书");
    expect(de[0].gloss).toBe("Buch");
  });

  it("skips entries that have no gloss in target language", () => {
    const entry = `
      <k_ele><keb>机</keb></k_ele>
      <r_ele><reb>つくえ</reb></r_ele>
      <sense><gloss>desk</gloss></sense>
    `;
    // No xml:lang="zho" here — zh lookup should yield nothing for this entry.
    expect(parseJMdictEntry(entry, "zh")).toHaveLength(0);
  });

  it("streams multiple entries from a full document", () => {
    const xml = `<?xml version="1.0"?>
      <!DOCTYPE JMdict [
        <!ENTITY v5k-s "Godan verb - Iku/Yuku">
      ]>
      <JMdict>
        <entry>
          <k_ele><keb>行く</keb></k_ele>
          <r_ele><reb>いく</reb></r_ele>
          <sense><gloss>to go</gloss></sense>
        </entry>
        <entry>
          <k_ele><keb>食べる</keb></k_ele>
          <r_ele><reb>たべる</reb></r_ele>
          <sense><gloss>to eat</gloss></sense>
        </entry>
      </JMdict>`;
    const entries = Array.from(parseJMdict(xml));
    expect(entries).toHaveLength(2);
    expect(entries[0].headword).toBe("行く");
    expect(entries[1].headword).toBe("食べる");
  });
});
