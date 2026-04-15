import { NextRequest, NextResponse } from "next/server";
import { uninstallDictionary } from "@/lib/dict/installer";
import { getCurrentUser } from "@/lib/auth";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const { id } = await params;
  const removed = await uninstallDictionary(id);
  if (!removed) {
    return NextResponse.json({ error: "Dictionary not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
