import { getDb } from "@/lib/db";
import { snapshot } from "@/lib/view";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const conversationId = new URL(request.url).searchParams.get("conversationId") || undefined;
  const data = await snapshot(getDb(), conversationId);
  return NextResponse.json(data);
}
