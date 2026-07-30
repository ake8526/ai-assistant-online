import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { handleCommand } from "@/lib/commands";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 60;

// POST { text, context? } → run a natural-language command for the signed-in user
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = await req.json();
    const text = String(body.text || "").trim();
    if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
    const result = await handleCommand(upn, text, body.context || undefined);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
