import { NextRequest, NextResponse } from "next/server";
import { ensureDataDir } from "@/lib/db/init";
import { installDictionary, listDictionaries } from "@/lib/dict/installer";
import { detectDictFormat } from "@/lib/dict/format-detect";
import { getCurrentUser } from "@/lib/auth";
import { gunzipSync } from "zlib";

const MAX_SIZE = 80 * 1024 * 1024; // 80MB (JMdict decompressed ~30MB, CEDICT ~8MB)

// Dictionaries are shared global resources — JMdict/CEDICT are bulky and
// everyone benefits from the same lookup table for /api/dict/lookup. But
// the management surface (list/install/delete) is admin-only: we don't
// want untrusted users seeing what's installed or uploading arbitrary
// files into the dict parser path.
export async function GET() {
  ensureDataDir();
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const dicts = await listDictionaries();
  return NextResponse.json(dicts);
}

export async function POST(request: NextRequest) {
  ensureDataDir();
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const customName = formData.get("name") as string | null;
  const targetLangInput = (formData.get("targetLang") as string | null)?.trim() || null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "File too large (max 80MB)" }, { status: 400 });
  }

  try {
    const raw = Buffer.from(await file.arrayBuffer());

    // gzip-decompress if the file name ends with .gz OR the magic bytes match.
    const isGzip =
      file.name.toLowerCase().endsWith(".gz") ||
      (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b);
    const decompressed = isGzip ? gunzipSync(raw) : raw;
    const text = decompressed.toString("utf-8");

    const info = detectDictFormat(text);
    if (!info) {
      return NextResponse.json(
        { error: "Unrecognized dictionary format. Supported: JMdict (XML), CC-CEDICT (text)." },
        { status: 400 },
      );
    }

    // Pick target language: user-specified wins if it's in the set the file
    // advertises; otherwise fall back to the first available (English for
    // JMdict_e and CC-CEDICT, which advertise just ['en']).
    const targetLang =
      targetLangInput && info.availableTargetLangs.includes(targetLangInput as typeof info.availableTargetLangs[number])
        ? (targetLangInput as typeof info.availableTargetLangs[number])
        : info.availableTargetLangs[0];

    // Name disambiguation: if the user didn't supply a custom name and the
    // file has multiple target langs, suffix the chosen lang so "JMdict (zh)"
    // vs "JMdict (en)" are distinguishable in the list.
    const baseName = customName?.trim() || info.suggestedName;
    const autoSuffix =
      !customName?.trim() && info.availableTargetLangs.length > 1
        ? ` (${targetLang})`
        : "";

    const result = await installDictionary({
      name: baseName + autoSuffix,
      format: info.format,
      sourceLang: info.sourceLang,
      targetLang,
      text,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("Dictionary upload error:", err);
    const message = err instanceof Error ? err.message : "Failed to install dictionary";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
