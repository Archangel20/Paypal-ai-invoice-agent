import { handleUserMessage } from "@/lib/agent";
import { HttpError } from "@/lib/actions";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { message?: unknown; conversationId?: unknown };
    const message = typeof body.message === "string" ? body.message : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : undefined;
    const snapshot = await handleUserMessage(getDb(), conversationId, message);
    return NextResponse.json(snapshot);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    const message = error instanceof Error ? error.message : "Could not run that instruction.";
    return NextResponse.json({ error: message }, { status });
  }
}
