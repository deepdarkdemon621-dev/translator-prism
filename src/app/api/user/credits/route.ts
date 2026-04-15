import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { grantCredits } from "@/lib/billing";

/**
 * Fake top-up for phase-2 dev. Any signed-in user can credit themselves,
 * admins can credit anyone. When Stripe / Alipay land this stays as a
 * dev-only path guarded by NODE_ENV, and the payment webhook calls
 * grantCredits() directly with a verified amount.
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();

  let body: { amount?: number; userId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return NextResponse.json(
      { error: "`amount` must be a positive number (max 1000000)" },
      { status: 400 },
    );
  }

  const targetUserId = body.userId ?? user.id;
  if (targetUserId !== user.id && !user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const next = await grantCredits(targetUserId, amount);
  return NextResponse.json({ userId: targetUserId, credits: next });
}
