import { NextRequest, NextResponse } from "next/server";
import { ensureDataDir } from "@/lib/db/init";
import { lookupWord } from "@/lib/dict/lookup";

export async function POST(request: NextRequest) {
  ensureDataDir();

  let body: { lang?: string; query?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const lang = body.lang;
  const query = body.query;
  if (!lang || !query) {
    return NextResponse.json(
      { error: "Both `lang` and `query` are required" },
      { status: 400 },
    );
  }

  if (lang !== "ja" && lang !== "zh" && lang !== "en") {
    return NextResponse.json({ error: "Unsupported lang" }, { status: 400 });
  }

  try {
    const results = await lookupWord({ lang, query });
    return NextResponse.json({ results });
  } catch (err) {
    console.error("Dictionary lookup error:", err);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
}
