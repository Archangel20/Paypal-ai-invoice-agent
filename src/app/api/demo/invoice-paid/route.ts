import { HttpError, simulatePayment } from "@/lib/actions";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { invoiceId?: unknown; conversationId?: unknown };
    if (typeof body.invoiceId !== "string" || !body.invoiceId) {
      return NextResponse.json({ error: "invoiceId is required." }, { status: 400 });
    }
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : undefined;
    const data = await simulatePayment(getDb(), body.invoiceId, conversationId);
    return NextResponse.json(data);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Could not simulate payment.";
    return NextResponse.json({ error: message }, { status });
  }
}
