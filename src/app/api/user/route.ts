import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

/**
 * Lightweight session endpoint for the client. Returns the trimmed
 * SessionUser used elsewhere — good enough for header balance display
 * and admin-gated UI toggles.
 */
export async function GET() {
  const user = await getCurrentUser();
  return NextResponse.json(user);
}
