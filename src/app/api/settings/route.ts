import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getCurrentUser } from "@/lib/auth";

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

const DEFAULT_SETTINGS = {
  llm: {
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    apiKey: "",
    concurrency: 2,
  },
  reading: {
    theme: "dark",
    fontSize: 16,
    lineHeight: 1.8,
    paragraphSpacing: "standard",
    fonts: {
      ja: "Noto Serif JP",
      zh: "Noto Serif SC",
      en: "Georgia",
    },
  },
};

async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_PATH, "utf-8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function GET() {
  // Settings are global (shared LLM key + defaults). Only admins should see
  // or edit them — non-admins shouldn't even learn whether a key is set.
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const settings = await loadSettings();
  // Don't expose API key fully
  return NextResponse.json({
    ...settings,
    llm: {
      ...settings.llm,
      apiKey: settings.llm.apiKey ? "***configured***" : "",
    },
  });
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const body = await request.json();
  const current = await loadSettings();

  // Strip the masking sentinel so clients can round-trip GET→PUT without corrupting the real key
  const incomingLlm = { ...body.llm };
  if (incomingLlm.apiKey === "***configured***") {
    delete incomingLlm.apiKey;
  }

  const merged = {
    ...current,
    ...body,
    llm: { ...current.llm, ...incomingLlm },
    reading: { ...current.reading, ...body.reading, fonts: { ...current.reading.fonts, ...body.reading?.fonts } },
  };

  await fs.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  // The worker reads settings on demand per job, so no in-process reset
  // is needed here. Settings changes take effect on the next job poll.
  return NextResponse.json({ success: true });
}
