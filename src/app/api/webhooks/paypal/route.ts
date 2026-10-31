import { handleIncomingPayPalEvent } from "@/lib/actions";
import { getDb } from "@/lib/db";
import { verifyWebhookSignature } from "@/lib/paypal";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    listener: "Splitnote PayPal webhook",
    events: ["INVOICING.INVOICE.PAID", "PAYMENT.PAYOUTSBATCH.*", "PAYMENT.PAYOUTS-ITEM.*"],
  });
}

export async function POST(request: Request) {
  const raw = await request.text();
  let event: unknown;
  try {
    event = JSON.parse(raw) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const verification = await verifyWebhookSignature(request.headers, event);
  if (!verification.verified) {
    return NextResponse.json({ error: verification.reason || "Webhook signature was rejected." }, { status: 401 });
  }

  try {
    const result = await handleIncomingPayPalEvent(getDb(), event, true);
    return NextResponse.json({ ok: true, outcome: result.outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook handler failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
