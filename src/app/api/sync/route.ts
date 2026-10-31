import { HttpError, syncFromPayPal } from "@/lib/actions";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { conversationId?: unknown };
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : undefined;
    const data = await syncFromPayPal(getDb(), conversationId);
    return NextResponse.json(data);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Sync failed.";
    return NextResponse.json({ error: message }, { status });
  }
}
